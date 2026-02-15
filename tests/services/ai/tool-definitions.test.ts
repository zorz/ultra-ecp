/**
 * Tool Definitions Unit Tests
 *
 * Tests for ECP tool definitions.
 */

import { describe, it, expect } from 'bun:test';
import {
  fileTools,
  documentTools,
  gitTools,
  terminalTools,
  lspTools,
  claudeCodeTools,
  chatTools,
  delegateToAgentTool,
  allECPTools,
  getToolsByCategory,
  getToolByName,
} from '../../../src/services/ai/tools/definitions.ts';

describe('Tool Definitions', () => {
  describe('fileTools', () => {
    it('should have file operation tools', () => {
      expect(fileTools.length).toBeGreaterThan(0);

      const toolNames = fileTools.map((t) => t.name);
      expect(toolNames).toContain('file_read');
      expect(toolNames).toContain('file_write');
      expect(toolNames).toContain('file_list');
      expect(toolNames).toContain('file_exists');
    });

    it('should have valid input schemas', () => {
      for (const tool of fileTools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('should have ECP method mappings', () => {
      for (const tool of fileTools) {
        expect(tool.ecpMethod).toBeDefined();
        expect(tool.ecpMethod).toMatch(/^file\//);
      }
    });
  });

  describe('documentTools', () => {
    it('should have document operation tools', () => {
      expect(documentTools.length).toBeGreaterThan(0);

      const toolNames = documentTools.map((t) => t.name);
      expect(toolNames).toContain('document_open');
      expect(toolNames).toContain('document_content');
      expect(toolNames).toContain('document_insert');
      expect(toolNames).toContain('document_replace');
    });
  });

  describe('gitTools', () => {
    it('should have git operation tools', () => {
      expect(gitTools.length).toBeGreaterThan(0);

      const toolNames = gitTools.map((t) => t.name);
      expect(toolNames).toContain('git_status');
      expect(toolNames).toContain('git_diff');
      expect(toolNames).toContain('git_log');
      expect(toolNames).toContain('git_commit');
    });
  });

  describe('terminalTools', () => {
    it('should have terminal operation tools', () => {
      expect(terminalTools.length).toBeGreaterThan(0);

      const toolNames = terminalTools.map((t) => t.name);
      expect(toolNames).toContain('terminal_execute');
      expect(toolNames).toContain('terminal_spawn');
    });
  });

  describe('lspTools', () => {
    it('should have LSP operation tools', () => {
      expect(lspTools.length).toBeGreaterThan(0);

      const toolNames = lspTools.map((t) => t.name);
      expect(toolNames).toContain('lsp_diagnostics');
      expect(toolNames).toContain('lsp_definition');
      expect(toolNames).toContain('lsp_references');
    });
  });

  describe('claudeCodeTools', () => {
    it('should have Claude Code compatible tools', () => {
      expect(claudeCodeTools.length).toBeGreaterThan(0);

      const toolNames = claudeCodeTools.map((t) => t.name);
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Write');
      expect(toolNames).toContain('Edit');
      expect(toolNames).toContain('Glob');
      expect(toolNames).toContain('Grep');
      expect(toolNames).toContain('Bash');
      expect(toolNames).toContain('LS');
    });

    it('should have correct parameter names for Claude Code', () => {
      const readTool = claudeCodeTools.find((t) => t.name === 'Read');

      expect(readTool).toBeDefined();
      expect(readTool!.inputSchema.properties).toHaveProperty('file_path');
    });

    it('should map to ECP methods', () => {
      const readTool = claudeCodeTools.find((t) => t.name === 'Read');
      const bashTool = claudeCodeTools.find((t) => t.name === 'Bash');

      expect(readTool!.ecpMethod).toBe('file/read');
      expect(bashTool!.ecpMethod).toBe('terminal/execute');
    });
  });

  describe('allECPTools', () => {
    it('should contain all tool categories', () => {
      expect(allECPTools.length).toBe(
        fileTools.length +
        documentTools.length +
        gitTools.length +
        terminalTools.length +
        lspTools.length +
        claudeCodeTools.length +
        chatTools.length
      );
    });

    it('should have unique tool names', () => {
      const names = allECPTools.map((t) => t.name);
      const uniqueNames = [...new Set(names)];

      expect(names.length).toBe(uniqueNames.length);
    });
  });

  describe('getToolsByCategory', () => {
    it('should return file tools', () => {
      const tools = getToolsByCategory('file');

      expect(tools).toEqual(fileTools);
    });

    it('should return document tools', () => {
      const tools = getToolsByCategory('document');

      expect(tools).toEqual(documentTools);
    });

    it('should return git tools', () => {
      const tools = getToolsByCategory('git');

      expect(tools).toEqual(gitTools);
    });

    it('should return terminal tools', () => {
      const tools = getToolsByCategory('terminal');

      expect(tools).toEqual(terminalTools);
    });

    it('should return lsp tools', () => {
      const tools = getToolsByCategory('lsp');

      expect(tools).toEqual(lspTools);
    });

    it('should return empty array for unknown category', () => {
      const tools = getToolsByCategory('unknown');

      expect(tools).toEqual([]);
    });
  });

  describe('getToolByName', () => {
    it('should find tool by name', () => {
      const tool = getToolByName('Read');

      expect(tool).toBeDefined();
      expect(tool!.name).toBe('Read');
      expect(tool!.ecpMethod).toBe('file/read');
    });

    it('should return undefined for non-existent tool', () => {
      const tool = getToolByName('NonExistentTool');

      expect(tool).toBeUndefined();
    });

    it('should find tools from all categories', () => {
      expect(getToolByName('file_read')).toBeDefined();
      expect(getToolByName('document_open')).toBeDefined();
      expect(getToolByName('git_status')).toBeDefined();
      expect(getToolByName('terminal_execute')).toBeDefined();
      expect(getToolByName('lsp_diagnostics')).toBeDefined();
    });
  });

  describe('tool schema validation', () => {
    it('all tools should have required fields', () => {
      for (const tool of allECPTools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');

        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');

        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('tools with required params should have valid required array', () => {
      for (const tool of allECPTools) {
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);

          // All required params should exist in properties
          for (const param of tool.inputSchema.required) {
            expect(tool.inputSchema.properties).toHaveProperty(param);
          }
        }
      }
    });
  });

  describe('claudeCodeTools - CRUD tools', () => {
    it('should have TodoRead mapping to ai/todo/get', () => {
      const tool = claudeCodeTools.find(t => t.name === 'TodoRead');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('ai/todo/get');
    });

    it('should have TodoWrite mapping to ai/todo/write', () => {
      const tool = claudeCodeTools.find(t => t.name === 'TodoWrite');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('ai/todo/write');
    });

    it('should have Plan CRUD tools with correct ECP methods', () => {
      const planCreate = claudeCodeTools.find(t => t.name === 'PlanCreate');
      expect(planCreate?.ecpMethod).toBe('chat/plan/create');

      const planUpdate = claudeCodeTools.find(t => t.name === 'PlanUpdate');
      expect(planUpdate?.ecpMethod).toBe('chat/plan/update');

      const planRead = claudeCodeTools.find(t => t.name === 'PlanRead');
      expect(planRead?.ecpMethod).toBe('chat/plan/list');

      const planGet = claudeCodeTools.find(t => t.name === 'PlanGet');
      expect(planGet?.ecpMethod).toBe('chat/plan/content');
    });

    it('should have Spec CRUD tools with correct ECP methods', () => {
      const specCreate = claudeCodeTools.find(t => t.name === 'SpecCreate');
      expect(specCreate?.ecpMethod).toBe('chat/spec/create');

      const specRead = claudeCodeTools.find(t => t.name === 'SpecRead');
      expect(specRead?.ecpMethod).toBe('chat/spec/list');

      const specUpdate = claudeCodeTools.find(t => t.name === 'SpecUpdate');
      expect(specUpdate?.ecpMethod).toBe('chat/spec/update');
    });

    it('should have Document CRUD tools with correct ECP methods', () => {
      const docCreate = claudeCodeTools.find(t => t.name === 'DocumentCreate');
      expect(docCreate?.ecpMethod).toBe('chat/document/create');

      const docUpdate = claudeCodeTools.find(t => t.name === 'DocumentUpdate');
      expect(docUpdate?.ecpMethod).toBe('chat/document/update');

      const docList = claudeCodeTools.find(t => t.name === 'DocumentList');
      expect(docList?.ecpMethod).toBe('chat/document/list');

      const docGet = claudeCodeTools.find(t => t.name === 'DocumentGet');
      expect(docGet?.ecpMethod).toBe('chat/document/get');

      const docSearch = claudeCodeTools.find(t => t.name === 'DocumentSearch');
      expect(docSearch?.ecpMethod).toBe('chat/document/search');
    });

    it('should have SearchChatHistory mapping to chat/message/search', () => {
      const tool = getToolByName('SearchChatHistory');
      expect(tool).toBeDefined();
      expect(tool!.ecpMethod).toBe('chat/message/search');
    });
  });

  describe('delegateToAgentTool', () => {
    it('should have name DelegateToAgent', () => {
      expect(delegateToAgentTool.name).toBe('DelegateToAgent');
    });

    it('should require agentId and message', () => {
      expect(delegateToAgentTool.inputSchema.required).toContain('agentId');
      expect(delegateToAgentTool.inputSchema.required).toContain('message');
    });

    it('should NOT be in allECPTools', () => {
      const found = allECPTools.find(t => t.name === 'DelegateToAgent');
      expect(found).toBeUndefined();
    });

    it('should have optional context parameter', () => {
      expect(delegateToAgentTool.inputSchema.properties).toHaveProperty('context');
    });
  });

  describe('chatTools', () => {
    it('should contain SearchChatHistory', () => {
      const toolNames = chatTools.map(t => t.name);
      expect(toolNames).toContain('SearchChatHistory');
    });

    it('should be included in allECPTools', () => {
      for (const tool of chatTools) {
        const found = allECPTools.find(t => t.name === tool.name);
        expect(found).toBeDefined();
      }
    });
  });
});
