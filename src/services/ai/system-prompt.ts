/**
 * AI System Prompt
 *
 * Comprehensive system prompt for the Ultra IDE AI assistant.
 * Includes tool guidance, anti-hallucination rules, and planning behavior.
 *
 * System prompt composition order for agents:
 * 1. Agent identity block (name, role, description)
 * 2. PERSONA: compressed text (if persona assigned)
 * 3. AGENCY: structured block (if agency defined)
 * 4. FALLBACK: legacy systemPrompt (only if no persona AND no agency)
 * 5. Base workspace/tool prompt
 * 6. Transcript context
 */

import type { AgentAgency } from '../chat/types/workflow-schema.ts';

/**
 * Build the system prompt with workspace context.
 */
export function buildSystemPrompt(workspaceRoot?: string): string {
  const workspaceContext = workspaceRoot
    ? `You are working in the project at: ${workspaceRoot}\n\nUse absolute paths within this workspace for all file operations.`
    : 'No workspace is currently open.';

  return `# Ultra IDE AI Assistant

You are an AI coding assistant integrated into the Ultra IDE. Your role is to help users with software development tasks including writing code, debugging, refactoring, and project planning.

## Workspace
${workspaceContext}

---

## CRITICAL RULES

### Rule 1: You MUST Use Tools to Take Actions
**Never claim to have done something without actually calling the tool and receiving a result.**

- WRONG: "I've updated the file to add the function." (no tool call made)
- WRONG: "Let me update that for you." (then not calling any tool)
- RIGHT: [Calls Edit tool] → [Receives success result] → "The file has been updated."

If you say you will do something, you MUST call the appropriate tool. Describing an action is NOT the same as performing it.

### Rule 2: Verify Tool Results Before Claiming Success
After calling a tool, check the result:
- If successful, confirm what was accomplished
- If failed, acknowledge the error and try to fix it
- Never assume success without seeing the result

### Rule 3: Use the Right Tool for the Job
- **For plans**: Use PlanCreate / PlanUpdate - NOT Write to create markdown files
- **For todos**: Use TodoWrite - NOT comments in code or markdown files
- **For specs**: Use SpecCreate - NOT Write to create documentation files
- **For file edits**: Use Edit for surgical changes, Write only for new files or complete rewrites

---

## Available Tools

### File Operations
| Tool | Purpose |
|------|---------|
| Read | Read file contents |
| Write | Create new files or completely overwrite existing ones |
| Edit | Make precise text replacements in existing files |
| Glob | Find files matching a pattern |
| Grep | Search for text/patterns in files |
| LS | List directory contents |

### Terminal
| Tool | Purpose |
|------|---------|
| Bash | Execute shell commands |

### Planning & Task Management
| Tool | Purpose | When to Use |
|------|---------|-------------|
| SpecCreate | Create a specification | Large features/projects with multiple phases |
| SpecRead | List existing specifications | Check what specs exist before creating new ones |
| PlanCreate | Create an implementation plan | Multi-step tasks requiring strategy before coding |
| PlanUpdate | Update a plan's content/status | Mark plans complete, update as work progresses |
| PlanRead | List existing plans | See current plans and their status |
| TodoWrite | Track task progress | Break plans into actionable items, track completion |

---

## Planning Hierarchy

Specification (large initiative)
  └── Plan (implementation strategy)
       └── Todo (individual task)

**Specifications**: High-level requirements documents for major features or projects. Use when the scope spans multiple implementation phases.

**Plans**: Detailed implementation strategies. Include the approach, key decisions, phases, and considerations. Use for any multi-step task.

**Todos**: Atomic tasks that can be completed in a single action. Use to track progress through a plan.

---

## Auto-Planning Behavior

**Automatically create a plan when:**
1. The user asks to implement a feature with multiple components
2. The task requires more than 3-4 file changes
3. There are significant architectural decisions to make
4. The user explicitly asks you to plan or think through the approach

**Skip planning when:**
1. The task is a simple bug fix or small change
2. The user says "just do it" or "quick fix"
3. The change is isolated to a single file with clear requirements

When creating a plan:
1. First use PlanRead to check for existing relevant plans
2. Create the plan with PlanCreate (status: "active")
3. Break it into todos with TodoWrite
4. Work through todos, updating status as you go
5. When complete, use PlanUpdate to set status to "completed"

---

## Examples

### CORRECT: Using Planning Tools
User: "Add user authentication to the app"

1. [Calls PlanRead] - Check for existing auth plans
2. [Calls PlanCreate with title="User Authentication", content="## Overview..."]
3. [Calls TodoWrite with tasks: setup deps, create routes, add middleware, build UI]
4. [Calls Read, Edit, Write as needed for implementation]
5. [Updates TodoWrite status as tasks complete]
6. [Calls PlanUpdate to mark plan completed]

### WRONG: Writing Plans to Files (DON'T DO THIS)
User: "Add user authentication to the app"

[Calls Write to create docs/auth-plan.md] ← WRONG! Use PlanCreate instead
[Says "I've created a plan at docs/auth-plan.md"] ← Plan won't appear in UI

### CORRECT: Making a Code Change
User: "Add a logout button to the header"

1. [Calls Read to see current header file]
2. [Calls Edit to add the button code]
3. [Receives success result]
4. "I've added a logout button to the header component."

### WRONG: Hallucinating a Change
User: "Add a logout button to the header"

"I've added a logout button to the header that calls the logout API." ← WRONG!
(No tool was called - this is a hallucination)

---

## Response Style

- Be concise and direct
- Focus on actions, not lengthy explanations
- When you need to make changes, do it - don't just describe what you would do
- After tool calls, briefly confirm what was done
- If something fails, acknowledge it and propose a fix

Remember: Your actions are visible in the Activity Log. The user can see your plans, todos, and tool executions in real-time. Use the structured tools so your work is properly tracked.
`;
}

/**
 * Default system prompt without workspace context.
 */
export const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt();

/**
 * Build a roster block listing available agents for delegation.
 */
function buildAgentRosterBlock(
  agents: Array<{ id: string; name: string; role?: string; description?: string }>,
  currentAgentId?: string,
  excludeAgentIds?: string[],
): string {
  const otherAgents = agents.filter(a =>
    a.id !== currentAgentId &&
    !excludeAgentIds?.includes(a.id)
  );
  if (otherAgents.length === 0) return '';

  const lines = otherAgents.map(a => {
    const parts = [`- **${a.name}** (id: \`${a.id}\`)`];
    if (a.role) parts[0] += ` — role: ${a.role}`;
    if (a.description) parts.push(`  ${a.description}`);
    return parts.join('\n');
  });

  return `## Available Agents for Delegation

You can delegate tasks to other agents using the DelegateToAgent tool.
Call it when another agent is better suited for a subtask.

${lines.join('\n')}

### DelegateToAgent Tool
\`\`\`
DelegateToAgent({ agentId: "<agent-id>", message: "<task description>", context?: "<optional context>" })
\`\`\`
When you call DelegateToAgent, ALWAYS include a brief text explanation of what you are delegating and why BEFORE the tool call. Never use DelegateToAgent as your only action — always provide visible context to the user first.

You will finish your current response and the target agent will take over with the message you provide. Only delegate when another agent's expertise is genuinely needed.

IMPORTANT: Do NOT delegate a task back to the agent that delegated it to you. If you were asked to do something, do it yourself rather than passing it back.`;
}

/**
 * Build a structured agency block for the system prompt.
 */
export function buildAgencyBlock(agency: AgentAgency): string {
  const sections: string[] = ['## Agency'];

  if (agency.roleDescription) {
    sections.push(`### Role\n${agency.roleDescription}`);
  }

  if (agency.responsibilities?.length) {
    sections.push(`### Responsibilities\n${agency.responsibilities.map(r => `- ${r}`).join('\n')}`);
  }

  if (agency.expectedOutputs?.length) {
    sections.push(`### Expected Outputs\n${agency.expectedOutputs.map(o => `- ${o}`).join('\n')}`);
  }

  if (agency.constraints?.length) {
    sections.push(`### Constraints\n${agency.constraints.map(c => `- ${c}`).join('\n')}`);
  }

  if (agency.delegationRules?.canDelegate) {
    const dr = agency.delegationRules;
    const delegationParts = ['### Delegation'];
    if (dr.delegationCriteria?.length) {
      delegationParts.push(`**When to delegate:**\n${dr.delegationCriteria.map(c => `- ${c}`).join('\n')}`);
    }
    if (dr.preferredDelegates?.length) {
      delegationParts.push(`**Preferred delegates:** ${dr.preferredDelegates.join(', ')}`);
    }
    if (dr.escalationPolicy) {
      delegationParts.push(`**Escalation:** ${dr.escalationPolicy}`);
    }
    sections.push(delegationParts.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Build a system prompt tailored to a specific agent.
 *
 * Composes in order:
 * 1. Agent identity block (name, role, description)
 * 2. PERSONA: compressed text (if persona assigned)
 * 3. AGENCY: structured block (if agency defined)
 * 4. FALLBACK: legacy systemPrompt (only if no persona AND no agency)
 * 5. Base workspace/tool prompt
 * 6. Transcript context (if provided, for returning agents)
 */
export function buildAgentSystemPrompt(
  agentConfig?: {
    name?: string;
    role?: string;
    description?: string;
    systemPrompt?: string;
    personaCompressed?: string;
    agency?: AgentAgency;
  },
  workspaceRoot?: string,
  transcriptContext?: string,
): string {
  const parts: string[] = [];

  // 1. Agent identity block
  if (agentConfig) {
    const identity = [`# Agent: ${agentConfig.name || 'Assistant'}`];
    if (agentConfig.role) identity.push(`Role: ${agentConfig.role}`);
    if (agentConfig.description) identity.push(`Expertise: ${agentConfig.description}`);
    parts.push(identity.join('\n'));
  }

  const hasPersona = !!agentConfig?.personaCompressed;
  const hasAgency = !!agentConfig?.agency;

  // 2. PERSONA: compressed text (if persona assigned)
  if (hasPersona) {
    parts.push(`## Persona\n\n${agentConfig!.personaCompressed}`);
  }

  // 3. AGENCY: structured block (if agency defined)
  if (hasAgency) {
    parts.push(buildAgencyBlock(agentConfig!.agency!));
  }

  // 4. FALLBACK: legacy systemPrompt (only if no persona AND no agency)
  if (!hasPersona && !hasAgency && agentConfig?.systemPrompt) {
    parts.push(agentConfig.systemPrompt);
  }

  // 5. Base workspace/tool prompt
  parts.push(buildSystemPrompt(workspaceRoot));

  // 6. Transcript context for returning agents
  if (transcriptContext) {
    parts.push(`---\n\n## Conversation Context\n\nThe following is a summary of recent messages in the chat while you were inactive:\n\n${transcriptContext}`);
  }

  return parts.join('\n\n');
}

/**
 * Build a system prompt for an agent with delegation support.
 *
 * Extends buildAgentSystemPrompt with an agent roster for DelegateToAgent.
 * Used by both workflow agent nodes and regular chat agent sessions.
 */
export function buildWorkflowAgentSystemPrompt(
  agentConfig?: { name?: string; role?: string; description?: string; systemPrompt?: string; personaCompressed?: string; agency?: AgentAgency },
  workspaceRoot?: string,
  availableAgents?: Array<{ id: string; name: string; role?: string; description?: string }>,
  currentAgentId?: string,
  transcriptContext?: string,
  excludeAgentIds?: string[],
): string {
  const base = buildAgentSystemPrompt(agentConfig, workspaceRoot, transcriptContext);

  if (!availableAgents || availableAgents.length === 0) return base;

  const rosterBlock = buildAgentRosterBlock(availableAgents, currentAgentId, excludeAgentIds);
  if (!rosterBlock) return base;

  return `${base}\n\n---\n\n${rosterBlock}`;
}
