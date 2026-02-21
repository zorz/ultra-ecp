# Feature Research: Context, Agents, Personas, Workflows

Research conducted 2026-02-20. Covers archived flex-gui + Agent SDK findings.

---

## 1. Context Window & Compaction

### Compaction Service (Archive: CompactionService.ts)

**Data Structures:**
```typescript
IStoredCompaction {
  id, sessionId, summary, startMessageId, endMessageId, messageCount,
  tokensBefore, tokensAfter, createdAt, isActive, expandedAt, agentIds[]
}
```

**How Auto-Compaction Worked:**
- `selectMessagesForCompaction()` kept recent N messages (default: 10), compacted older ones
- Could specify `maxTokens` to limit compaction size
- Agent-aware: tracked which agents' messages were compacted via `agentBreakdown` map
- Manual trigger via `compactContext()` call

**Token Tracking:**
- Estimated tokens: `Math.ceil(text.length / 4)` (4 chars per token heuristic)
- Stored `tokensBefore` and `tokensAfter` in compaction record

**Key Method: `buildCuratedContext()`**
- Returns messages with active compactions applied (summaries replacing compacted ranges)
- Returns: `{ messages, totalTokens, compactionsApplied, hasCompactedContent }`

### Context Builder (Archive: ContextBuilder.ts)

```typescript
IBuildContextOptions {
  sessionId, agent?, maxTokens (default: 100000),
  systemPrompt?, includeSystemMessages?, additionalContext?, appendMessages?
}
```

**Token Counting:**
- Simple heuristic: `Math.ceil(text.length / 4)`
- Content blocks: Text=standard, tool_use=+50 overhead, tool_result=+30 overhead, image=1000 tokens
- System prompt deducted from context window upfront
- Response reserve: `min(maxTokens * 0.25, 4000)` tokens

**Context Window Management:**
1. Account for response reserve
2. Calculate remaining tokens for history
3. Build from newest messages backward (prioritize recent)
4. Ensure conversation starts with user message (Claude requirement)

### Compaction Store (Flex-GUI: compactionStore.ts)

**Zustand Store State:**
```typescript
{
  contextTokens: number,
  isCompacting: boolean,
  lastCompactionAt: Date | null,
  compactionThreshold: number,     // Default: 100,000 tokens
  showFullLog: boolean,
  hasCompactedContent: boolean
}
```

**Compaction Flow:**
1. Validate minimum message count (KEEP_RECENT_MESSAGES = 10)
2. Separate: messagesToCompact vs messagesToKeep
3. Collect agents in compaction range
4. Build conversation text with agent prefixes: `[AgentName] ROLE: content`
5. Create temp AI session to generate summary
6. Record compaction via `chat/compaction/create`
7. Add system message notifying agents of compaction
8. Cleanup temp session, rebuild context

### Flex-GUI Context UI (Iteration 004: Ambient AI Context)

**A. File Tree Highlighting** — files colored by context level (full/partial/mentioned/none)
**B. Line-Level Attention Heatmap** — gutter bar showing AI focus intensity
**C. Temporal Decay Timeline** — items with age/decay bars (green→yellow→orange→red)
**D. Context Budget Indicator** — segmented bar (system|context|messages), per-file breakdown, health status

### Agent SDK Context Events

- `SDKCompactBoundaryMessage` — emitted on compaction with `{ trigger: "manual"|"auto", pre_tokens }`
- `SDKResultMessage.usage` — input/output tokens per response
- `SDKResultMessage.modelUsage` — per-model breakdown with `contextWindow` limit
- `PreCompact` hook — fires before compaction
- `betas: ['context-1m-2025-08-07']` — 1M context window support

---

## 2. Persona Management

### PersonaService (Archive: PersonaService.ts)

**CRUD:** create, get, list, update, delete, duplicate, exists, count

**Schema Fields:**
- `id`, `name`, `description`
- `problem_space` (JSON), `high_level` (JSON), `archetype` (JSON), `principles` (JSON), `taste` (JSON)
- `compressed` (string) — final persona text for injection
- `pipeline_status` — 'draft' | 'refined' | 'approved'
- `avatar`, `color`, `is_system`

**Usage:** Personas are independent, reusable — attached to agents via `persona_id` or inline `persona` field. Define *who* an agent *is* (personality, style, values).

**UI:** 7-stage pipeline editor (Name, Problem Space, High-Level, Archetype, Principles, Taste, Compressed Output) with completion indicators.

---

## 3. Agent Management

### AgentService (Archive: AgentService.ts)

**CRUD:** create, get, getByName, list, update, delete, duplicate, getSystemAgents, exists, count

**Schema Fields:**
- `id`, `name`, `description`
- `role` — 'primary' | 'specialist' | 'reviewer' | 'orchestrator'
- `provider`, `model`, `system_prompt`
- `tools` (JSON array), `persona` (JSON), `persona_id`
- `agency` (JSON) — { roleDescription, responsibilities, expectedOutputs, constraints, delegationRules }
- `is_system`, `is_active`

**UI:** Role selector, provider/model picker, system prompt editor, tool access matrix, agency editor, persona linking.

---

## 4. Multi-Agent Chat Orchestration

### AgentManager (Archive: AgentManager.ts)

**Key Methods:**
- `parseMentions(text)` → `{ mentions, cleanText }` — @mention routing (multi-word support)
- `delegate(request)` → `IDelegationResult` — agent-to-agent handoff
- `registerAgent`, `unregisterAgent`, `setPrimaryAgent`, `updateStatus`

### ChatOrchestrator (Archive: ChatOrchestrator.ts)

**Agent Selection:**
1. Explicit routing: `sendMessage({ agentId })`
2. @mention routing: `@agent-name` in message
3. Primary agent fallback

**Handoff Mechanism:**
- `DelegateToAgent` tool: `{ targetAgentId, message, context }`
- Dynamic nodes for delegated agents
- Handoff depth limit: `MAX_HANDOFF_DEPTH = 5`

---

## 5. Workflow System

### WorkflowService (Archive: WorkflowService.ts)

**CRUD:** create, get, list, update, delete, getDefault, setDefault, getSystemWorkflows

**Schema:** name, description, source_type (file|inline), definition (JSON), trigger_type (manual|on_message|on_file_change|scheduled), agent_pool, default_agent_id

### WorkflowExecutor (Archive: WorkflowExecutor.ts)

**18 Node Types:** trigger, agent, router, permission_gate, checkpoint, decision, await_input, review_panel, condition, transform, merge, split, loop, vote, human, output

**Problems identified:**
- Too many node types (18) — complexity didn't match utility
- Dual orchestration (ChatOrchestrator + WorkflowExecutor) — unclear boundaries
- Review panels tacked on, three separate gating mechanisms
- Schema explosion (500+ lines), crude handoff depth limit
- Separate tool call tracking, dual context systems

### Agent SDK Native Subagents

- `agents: Record<string, AgentDefinition>` — define subagents programmatically
- Each gets own tools, prompt, model
- `SubagentStart`/`SubagentStop` hook events
- `maxTurns`, `maxBudgetUsd` for execution control

---

## 6. Current Rust ECP Status

| Feature | Status |
|---------|--------|
| Persona CRUD | Done — `chat/persona/*` with dual-DB |
| Agent CRUD | Done — `chat/agent/*` with dual-DB |
| Compaction storage | Done — `chat/compaction/{create,list,get,delete,expand,collapse}` |
| Message is_active | Done — compaction overlays |
| Workflow schema | Done — table exists, sessions link via workflow_id |
| Workflow CRUD | Not done — no handlers |
| Workflow execution | Not done — was bridge-delegated |
| AI sessions | Bridge-delegated — `ai/*` → TS |
| Token counting | Not exposed |
| Context budget data | Not exposed |
