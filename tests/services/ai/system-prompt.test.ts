/**
 * System Prompt Unit Tests
 *
 * Tests for buildSystemPrompt, buildAgentSystemPrompt, and buildWorkflowAgentSystemPrompt.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSystemPrompt,
  buildAgentSystemPrompt,
  buildWorkflowAgentSystemPrompt,
} from '../../../src/services/ai/system-prompt.ts';

describe('buildSystemPrompt', () => {
  it('should include workspace path when provided', () => {
    const prompt = buildSystemPrompt('/home/user/project');

    expect(prompt).toContain('/home/user/project');
    expect(prompt).toContain('absolute paths');
  });

  it('should show "no workspace" message when not provided', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('No workspace is currently open');
    expect(prompt).not.toContain('absolute paths within this workspace');
  });

  it('should include critical rules', () => {
    const prompt = buildSystemPrompt('/test');

    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('MUST Use Tools');
    expect(prompt).toContain('Verify Tool Results');
  });

  it('should include tool documentation', () => {
    const prompt = buildSystemPrompt('/test');

    expect(prompt).toContain('Read');
    expect(prompt).toContain('Write');
    expect(prompt).toContain('Edit');
    expect(prompt).toContain('Glob');
    expect(prompt).toContain('Grep');
    expect(prompt).toContain('Bash');
    expect(prompt).toContain('PlanCreate');
    expect(prompt).toContain('TodoWrite');
    expect(prompt).toContain('SpecCreate');
  });

  it('should include planning hierarchy', () => {
    const prompt = buildSystemPrompt('/test');

    expect(prompt).toContain('Planning Hierarchy');
    expect(prompt).toContain('Specification');
    expect(prompt).toContain('Plan');
    expect(prompt).toContain('Todo');
  });
});

describe('buildAgentSystemPrompt', () => {
  it('should prepend agent identity block', () => {
    const prompt = buildAgentSystemPrompt({
      name: 'Coder',
      role: 'specialist',
      description: 'Expert at writing code',
    });

    expect(prompt).toContain('# Agent: Coder');
    expect(prompt).toContain('Role: specialist');
    expect(prompt).toContain('Expertise: Expert at writing code');
  });

  it('should include custom system prompt before base prompt', () => {
    const customPrompt = 'You are a security auditor. Focus on OWASP top 10.';
    const prompt = buildAgentSystemPrompt({
      name: 'Auditor',
      systemPrompt: customPrompt,
    });

    expect(prompt).toContain(customPrompt);
    // Custom prompt should appear before the base prompt
    const customIdx = prompt.indexOf(customPrompt);
    const baseIdx = prompt.indexOf('# Ultra IDE AI Assistant');
    expect(customIdx).toBeLessThan(baseIdx);
  });

  it('should include workspace context from base prompt', () => {
    const prompt = buildAgentSystemPrompt(
      { name: 'Helper' },
      '/home/user/project',
    );

    expect(prompt).toContain('/home/user/project');
  });

  it('should append transcript context section', () => {
    const transcript = 'User asked about authentication. Coder implemented JWT.';
    const prompt = buildAgentSystemPrompt(
      { name: 'Reviewer' },
      '/test',
      transcript,
    );

    expect(prompt).toContain('Conversation Context');
    expect(prompt).toContain(transcript);
  });

  it('should use default name when not provided', () => {
    const prompt = buildAgentSystemPrompt({});

    expect(prompt).toContain('# Agent: Assistant');
  });

  it('should handle undefined config', () => {
    const prompt = buildAgentSystemPrompt(undefined);

    // Should still include base prompt
    expect(prompt).toContain('# Ultra IDE AI Assistant');
  });
});

describe('buildWorkflowAgentSystemPrompt', () => {
  const agents = [
    { id: 'coder', name: 'Coder', role: 'specialist', description: 'Writes code' },
    { id: 'reviewer', name: 'Reviewer', role: 'reviewer', description: 'Reviews code' },
    { id: 'planner', name: 'Planner', role: 'orchestrator', description: 'Plans tasks' },
  ];

  it('should include delegation roster excluding current agent', () => {
    const prompt = buildWorkflowAgentSystemPrompt(
      { name: 'Coder', role: 'specialist' },
      '/test',
      agents,
      'coder',
    );

    expect(prompt).toContain('Available Agents for Delegation');
    expect(prompt).toContain('Reviewer');
    expect(prompt).toContain('Planner');
    // Should not include self
    expect(prompt).not.toContain('**Coder** (id: `coder`)');
  });

  it('should include DelegateToAgent tool docs', () => {
    const prompt = buildWorkflowAgentSystemPrompt(
      { name: 'Coder' },
      '/test',
      agents,
      'coder',
    );

    expect(prompt).toContain('DelegateToAgent');
    expect(prompt).toContain('agentId');
    expect(prompt).toContain('message');
  });

  it('should return base prompt when no agents provided', () => {
    const prompt = buildWorkflowAgentSystemPrompt(
      { name: 'Solo' },
      '/test',
      [],
    );

    expect(prompt).not.toContain('Available Agents for Delegation');
    expect(prompt).toContain('# Ultra IDE AI Assistant');
  });

  it('should return base prompt when only current agent in list', () => {
    const prompt = buildWorkflowAgentSystemPrompt(
      { name: 'Solo' },
      '/test',
      [{ id: 'solo', name: 'Solo', role: 'primary' }],
      'solo',
    );

    expect(prompt).not.toContain('Available Agents for Delegation');
  });

  it('should include transcript context when provided', () => {
    const transcript = 'Previous context here.';
    const prompt = buildWorkflowAgentSystemPrompt(
      { name: 'Agent' },
      '/test',
      agents,
      'coder',
      transcript,
    );

    expect(prompt).toContain('Conversation Context');
    expect(prompt).toContain(transcript);
  });
});
