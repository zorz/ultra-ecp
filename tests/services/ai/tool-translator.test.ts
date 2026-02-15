/**
 * Tool Translator Unit Tests
 *
 * Tests for provider-specific tool translation.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ClaudeToolTranslator,
  OpenAIToolTranslator,
  GeminiToolTranslator,
  getToolTranslator,
  canonicalECPTools,
  getECPToolsByCategory,
  type ECPToolDefinition,
} from '../../../src/services/ai/tools/translator.ts';

describe('Tool Translator', () => {
  describe('canonicalECPTools', () => {
    it('should have canonical tool definitions', () => {
      expect(canonicalECPTools.length).toBeGreaterThan(0);
    });

    it('should have file tools', () => {
      const fileTools = canonicalECPTools.filter((t) => t.category === 'file');
      expect(fileTools.length).toBeGreaterThan(0);

      const names = fileTools.map((t) => t.name);
      expect(names).toContain('file.read');
      expect(names).toContain('file.write');
      expect(names).toContain('file.edit');
      expect(names).toContain('file.glob');
    });

    it('should have terminal tools', () => {
      const terminalTools = canonicalECPTools.filter((t) => t.category === 'terminal');
      expect(terminalTools.length).toBeGreaterThan(0);

      const names = terminalTools.map((t) => t.name);
      expect(names).toContain('terminal.execute');
    });

    it('should have valid ECP methods', () => {
      for (const tool of canonicalECPTools) {
        expect(tool.ecpMethod).toBeDefined();
        expect(tool.ecpMethod).toMatch(/^\w+\/\w+/);
      }
    });

    it('should have valid input schemas', () => {
      for (const tool of canonicalECPTools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('getECPToolsByCategory', () => {
    it('should filter tools by category', () => {
      const fileTools = getECPToolsByCategory('file');
      expect(fileTools.every((t) => t.category === 'file')).toBe(true);

      const terminalTools = getECPToolsByCategory('terminal');
      expect(terminalTools.every((t) => t.category === 'terminal')).toBe(true);
    });

    it('should return empty array for non-existent category', () => {
      // This would be a type error in TS, but testing defensive behavior
      const tools = getECPToolsByCategory('nonexistent' as ECPToolDefinition['category']);
      expect(tools).toEqual([]);
    });
  });

  describe('ClaudeToolTranslator', () => {
    let translator: ClaudeToolTranslator;

    beforeEach(() => {
      translator = new ClaudeToolTranslator();
    });

    it('should have correct provider ID', () => {
      expect(translator.providerId).toBe('claude');
    });

    it('should support Claude Code tool names', () => {
      expect(translator.isSupported('Read')).toBe(true);
      expect(translator.isSupported('Write')).toBe(true);
      expect(translator.isSupported('Edit')).toBe(true);
      expect(translator.isSupported('Glob')).toBe(true);
      expect(translator.isSupported('Grep')).toBe(true);
      expect(translator.isSupported('Bash')).toBe(true);
    });

    it('should not support unknown tools', () => {
      expect(translator.isSupported('UnknownTool')).toBe(false);
    });

    it('should get ECP tool name for provider tool', () => {
      expect(translator.getECPToolName('Read')).toBe('file.read');
      expect(translator.getECPToolName('Write')).toBe('file.write');
      expect(translator.getECPToolName('Bash')).toBe('terminal.execute');
    });

    it('should return null for unknown tool', () => {
      expect(translator.getECPToolName('Unknown')).toBeNull();
    });

    it('should map tool call to ECP format', () => {
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/test.txt' },
      };

      const result = translator.mapToolCall(toolCall);

      expect(result).not.toBeNull();
      expect(result!.ecpMethod).toBe('file/read');
      expect(result!.params.path).toBe('/test.txt');
    });

    it('should transform input parameter names', () => {
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'Edit',
        input: {
          file_path: '/test.txt',
          old_string: 'foo',
          new_string: 'bar',
        },
      };

      const result = translator.mapToolCall(toolCall);

      expect(result).not.toBeNull();
      expect(result!.params.path).toBe('/test.txt');
      expect(result!.params.old_string).toBe('foo');
      expect(result!.params.new_string).toBe('bar');
    });

    it('should return null for unsupported tool', () => {
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'UnknownTool',
        input: {},
      };

      const result = translator.mapToolCall(toolCall);

      expect(result).toBeNull();
    });

    it('should convert ECP tools to provider format', () => {
      const ecpTools = getECPToolsByCategory('file').slice(0, 3);

      const providerTools = translator.toProviderTools(ecpTools);

      expect(providerTools.length).toBeGreaterThan(0);
      // Each tool should have provider-specific name
      for (const tool of providerTools) {
        expect(tool.name).toBeDefined();
        expect(tool.ecpMethod).toBeDefined();
      }
    });
  });

  describe('OpenAIToolTranslator', () => {
    let translator: OpenAIToolTranslator;

    beforeEach(() => {
      translator = new OpenAIToolTranslator();
    });

    it('should have correct provider ID', () => {
      expect(translator.providerId).toBe('openai');
    });

    it('should support OpenAI tool names', () => {
      expect(translator.isSupported('read_file')).toBe(true);
      expect(translator.isSupported('write_file')).toBe(true);
      expect(translator.isSupported('edit_file')).toBe(true);
      expect(translator.isSupported('find_files')).toBe(true);
      expect(translator.isSupported('execute_command')).toBe(true);
    });

    it('should get ECP tool name for provider tool', () => {
      expect(translator.getECPToolName('read_file')).toBe('file.read');
      expect(translator.getECPToolName('execute_command')).toBe('terminal.execute');
    });

    it('should map tool call to ECP format', () => {
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'read_file',
        input: { file_path: '/test.txt' },
      };

      const result = translator.mapToolCall(toolCall);

      expect(result).not.toBeNull();
      expect(result!.ecpMethod).toBe('file/read');
      expect(result!.params.path).toBe('/test.txt');
    });
  });

  describe('GeminiToolTranslator', () => {
    let translator: GeminiToolTranslator;

    beforeEach(() => {
      translator = new GeminiToolTranslator();
    });

    it('should have correct provider ID', () => {
      expect(translator.providerId).toBe('gemini');
    });

    it('should support Gemini tool names', () => {
      expect(translator.isSupported('readFile')).toBe(true);
      expect(translator.isSupported('writeFile')).toBe(true);
      expect(translator.isSupported('editFile')).toBe(true);
      expect(translator.isSupported('executeCommand')).toBe(true);
    });

    it('should get ECP tool name for provider tool', () => {
      expect(translator.getECPToolName('readFile')).toBe('file.read');
      expect(translator.getECPToolName('executeCommand')).toBe('terminal.execute');
    });

    it('should map tool call with camelCase params', () => {
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'readFile',
        input: { filePath: '/test.txt' },
      };

      const result = translator.mapToolCall(toolCall);

      expect(result).not.toBeNull();
      expect(result!.ecpMethod).toBe('file/read');
      expect(result!.params.path).toBe('/test.txt');
    });
  });

  describe('canonicalECPTools - AI/CRUD tools', () => {
    it('should have ai.todo.read mapping to ai/todo/get', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.todo.read');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('ai/todo/get');
      expect(tool!.category).toBe('ai');
    });

    it('should have ai.plan.get mapping to chat/plan/content', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.plan.get');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/plan/content');
    });

    it('should have ai.spec.update mapping to chat/spec/update', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.spec.update');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/spec/update');
    });

    it('should have ai.document.get mapping to chat/document/get', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.document.get');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/document/get');
    });

    it('should have ai.document.search mapping to chat/document/search', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.document.search');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/document/search');
    });

    it('should have ai.chat.search mapping to chat/message/search', () => {
      const tool = canonicalECPTools.find(t => t.name === 'ai.chat.search');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/message/search');
    });
  });

  describe('Claude CRUD tool mappings', () => {
    let translator: ClaudeToolTranslator;

    beforeEach(() => {
      translator = new ClaudeToolTranslator();
    });

    it('should support all CRUD tools', () => {
      expect(translator.isSupported('TodoRead')).toBe(true);
      expect(translator.isSupported('TodoWrite')).toBe(true);
      expect(translator.isSupported('PlanCreate')).toBe(true);
      expect(translator.isSupported('PlanUpdate')).toBe(true);
      expect(translator.isSupported('PlanRead')).toBe(true);
      expect(translator.isSupported('PlanGet')).toBe(true);
      expect(translator.isSupported('SpecCreate')).toBe(true);
      expect(translator.isSupported('SpecRead')).toBe(true);
      expect(translator.isSupported('SpecUpdate')).toBe(true);
      expect(translator.isSupported('DocumentCreate')).toBe(true);
      expect(translator.isSupported('DocumentUpdate')).toBe(true);
      expect(translator.isSupported('DocumentList')).toBe(true);
      expect(translator.isSupported('DocumentGet')).toBe(true);
      expect(translator.isSupported('DocumentSearch')).toBe(true);
      expect(translator.isSupported('SearchChatHistory')).toBe(true);
    });

    it('should map Claude CRUD names to ECP names', () => {
      expect(translator.getECPToolName('TodoRead')).toBe('ai.todo.read');
      expect(translator.getECPToolName('PlanGet')).toBe('ai.plan.get');
      expect(translator.getECPToolName('SpecUpdate')).toBe('ai.spec.update');
      expect(translator.getECPToolName('DocumentGet')).toBe('ai.document.get');
      expect(translator.getECPToolName('DocumentSearch')).toBe('ai.document.search');
      expect(translator.getECPToolName('SearchChatHistory')).toBe('ai.chat.search');
    });
  });

  describe('OpenAI CRUD tool mappings', () => {
    let translator: OpenAIToolTranslator;

    beforeEach(() => {
      translator = new OpenAIToolTranslator();
    });

    it('should support OpenAI snake_case CRUD tools', () => {
      expect(translator.isSupported('read_todos')).toBe(true);
      expect(translator.isSupported('get_plan')).toBe(true);
      expect(translator.isSupported('update_spec')).toBe(true);
      expect(translator.isSupported('get_document')).toBe(true);
      expect(translator.isSupported('search_documents')).toBe(true);
      expect(translator.isSupported('search_chat_history')).toBe(true);
    });

    it('should map OpenAI names to ECP names', () => {
      expect(translator.getECPToolName('read_todos')).toBe('ai.todo.read');
      expect(translator.getECPToolName('get_plan')).toBe('ai.plan.get');
      expect(translator.getECPToolName('update_spec')).toBe('ai.spec.update');
      expect(translator.getECPToolName('get_document')).toBe('ai.document.get');
      expect(translator.getECPToolName('search_documents')).toBe('ai.document.search');
    });
  });

  describe('Gemini CRUD tool mappings', () => {
    let translator: GeminiToolTranslator;

    beforeEach(() => {
      translator = new GeminiToolTranslator();
    });

    it('should support Gemini camelCase CRUD tools', () => {
      expect(translator.isSupported('readTodos')).toBe(true);
      expect(translator.isSupported('getPlan')).toBe(true);
      expect(translator.isSupported('updateSpec')).toBe(true);
      expect(translator.isSupported('getDocument')).toBe(true);
      expect(translator.isSupported('searchDocuments')).toBe(true);
      expect(translator.isSupported('searchChatHistory')).toBe(true);
    });

    it('should map Gemini names to ECP names', () => {
      expect(translator.getECPToolName('readTodos')).toBe('ai.todo.read');
      expect(translator.getECPToolName('getPlan')).toBe('ai.plan.get');
      expect(translator.getECPToolName('updateSpec')).toBe('ai.spec.update');
      expect(translator.getECPToolName('getDocument')).toBe('ai.document.get');
      expect(translator.getECPToolName('searchDocuments')).toBe('ai.document.search');
    });
  });

  describe('getToolTranslator factory', () => {
    it('should return Claude translator for claude', () => {
      const translator = getToolTranslator('claude');

      expect(translator.providerId).toBe('claude');
    });

    it('should return OpenAI translator for openai', () => {
      const translator = getToolTranslator('openai');

      expect(translator.providerId).toBe('openai');
    });

    it('should return Gemini translator for gemini', () => {
      const translator = getToolTranslator('gemini');

      expect(translator.providerId).toBe('gemini');
    });

    it('should default to Claude translator for unknown provider', () => {
      const translator = getToolTranslator('unknown');

      expect(translator.providerId).toBe('claude');
    });
  });
});
