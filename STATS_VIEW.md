# Stats View — ECP Implementation Spec

## Context

The GUI clients (macOS, iPad) have a **Stats View** — a real-time dashboard that shows tool call activity, file hotspots, execution speed, iteration depth, file dependencies, and session health. Currently all computation happens client-side from live `ai/stream/event` notifications. This means stats are lost on app restart and every client must independently compute the same metrics.

**Goal:** Move stats computation to the ECP server, backed by the database. The GUI becomes a passive consumer — it calls an RPC, gets back pre-computed metrics, and renders them. Stats survive restarts, work across all clients, and are computed once.

---

## Current Client-Side Stats (to replicate server-side)

The client currently tracks and displays:

### 1. Session Pulse
- Total tool operations count
- Error rate (failed / total)
- Currently active tool name
- Session duration (time since first op)
- Unique file count

### 2. File Activity
- Per-file breakdown: read count, write count, edit count, first seen, last seen, total ops
- Sorted by total ops descending (top 20)

### 3. Churn Alerts
- Files edited ≥ 3 times within 60 seconds
- Deduplicated (no re-alert within 120s for same file)

### 4. Scope Drift
- Directory-level operation counts
- "Initial scope" directories (from first 20 operations)
- "Drift" directories (touched later, outside initial scope)
- Drift ratio: drift dirs / total unique dirs (0–1)

### 5. Execution Speed
- Ops per minute (last 60s rolling window)
- Average latency by tool type (ms)
- Top 5 slowest operations
- Speed sparkline: ops/minute per 1-minute bucket over last 10 minutes
- Think vs Execute: gap time between tools (thinking) vs tool duration (executing)

### 6. Iteration Depth
- Current iteration number
- Total iteration count
- Think-only vs with-tools iterations (hasToolUse flag)
- Average tools per iteration
- Iteration velocity: duration of each completed iteration

### 7. File Dependencies
- Co-touched files: file pairs operated on within 30s of each other, with co-touch count
- Edit chains: last 30 sequential file operations showing workflow order

### 8. Session Health Score
- Focus score (0–100): inverse of scope drift ratio
- Efficiency score (0–100): unique files / total ops ratio
- Error score (0–100): inverse of error rate
- Overall health: weighted average (focus 30%, efficiency 30%, error 40%)
- Health level: good (≥70), warning (40–69), poor (<40)

### 9. Tool Breakdown
- Per-tool-type counts and error counts
- Sorted by count descending

---

## What's Already in the Database

### `tool_calls` table (migration 005)
```sql
id              TEXT PRIMARY KEY
session_id      TEXT NOT NULL (FK → sessions)
agent_id        TEXT
agent_name      TEXT
tool_name       TEXT NOT NULL
input           TEXT (JSON)
output          TEXT (JSON)
status          TEXT ('pending'|'awaiting_permission'|'approved'|'denied'|'running'|'success'|'error')
error_message   TEXT
started_at      REAL (ms timestamp)
completed_at    REAL (ms timestamp)
```
Indexed on: `session_id`, `status`, `tool_name`, `agent_id`

### `sessions` table
```sql
id              TEXT PRIMARY KEY
title           TEXT
status          TEXT
provider        TEXT
model           TEXT
iteration_count INTEGER
created_at      REAL (ms timestamp)
updated_at      REAL
completed_at    REAL
```

### `session_agents` table
```sql
session_id      TEXT
agent_id        TEXT
role            TEXT ('primary'|'specialist'|'reviewer'|'orchestrator')
joined_at       REAL (ms timestamp)
left_at         REAL
```

### What's NOT in the database
- **Iteration events** — `iteration_start`/`iteration_complete` are only emitted as live stream events, not persisted. The `sessions.iteration_count` field exists but isn't clear if it's maintained.
- **Co-touch relationships** — derived from temporal proximity of tool calls, not stored.
- **Scope/drift classification** — derived from directory analysis, not stored.

---

## Proposed RPC: `stats/session`

### Request
```typescript
interface StatsSessionParams {
  sessionId: string;
}
```

### Response
```typescript
interface StatsSessionResult {
  pulse: {
    totalOps: number;
    errorCount: number;
    errorRate: number;           // 0–1
    uniqueFileCount: number;
    sessionDurationMs: number;   // ms since first tool call
    activeToolName: string | null;
  };

  fileActivity: Array<{
    filePath: string;
    readCount: number;
    writeCount: number;
    editCount: number;
    totalOps: number;
    firstSeenMs: number;         // ms timestamp
    lastSeenMs: number;
  }>;  // sorted by totalOps desc, top 50

  churnAlerts: Array<{
    filePath: string;
    editCount: number;
    windowSeconds: number;
  }>;

  scopeDrift: {
    directoryCounts: Record<string, number>;  // dir → op count
    initialDirectories: string[];             // first 20 ops' dirs
    driftDirectories: string[];               // dirs outside initial
    driftRatio: number;                       // 0–1
  };

  executionSpeed: {
    opsPerMinute: number;                     // last 60s
    averageLatencyByTool: Array<{
      toolName: string;
      avgMs: number;
      count: number;
    }>;
    slowestOperations: Array<{
      id: string;
      toolName: string;
      filePath: string | null;
      durationMs: number;
    }>;  // top 5
    speedSparkline: number[];                 // ops/min per 1-min bucket, last 10 min
    thinkTimeMs: number;                      // total gap time between tools
    executeTimeMs: number;                    // total tool execution time
  };

  iterationDepth: {
    currentIteration: number;
    totalIterations: number;
    thinkOnlyCount: number;                   // iterations without tool use
    withToolsCount: number;                   // iterations with tool use
    toolsPerIteration: number;                // average
    iterationDurationsMs: number[];           // duration of each iteration
  };

  fileDependencies: {
    coTouchedFiles: Array<{
      fileA: string;
      fileB: string;
      count: number;
    }>;  // top 20, sorted by count desc
    editChain: Array<{
      toolName: string;
      filePath: string;
      timestampMs: number;
    }>;  // last 30 sequential file ops
  };

  health: {
    focusScore: number;         // 0–100
    efficiencyScore: number;    // 0–100
    errorScore: number;         // 0–100
    overallScore: number;       // 0–100 weighted
    level: 'good' | 'warning' | 'poor';
  };

  toolBreakdown: Array<{
    toolName: string;
    count: number;
    errorCount: number;
  }>;  // sorted by count desc
}
```

---

## Implementation Notes

### SQL Queries (all against `tool_calls` WHERE `session_id = ?`)

**Pulse + Tool Breakdown:**
```sql
SELECT tool_name,
       COUNT(*) as count,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
FROM tool_calls
WHERE session_id = ?
GROUP BY tool_name
ORDER BY count DESC;
```

**File Activity** (extract file_path from JSON input):
```sql
SELECT
  COALESCE(
    json_extract(input, '$.file_path'),
    json_extract(input, '$.path')
  ) as file_path,
  tool_name,
  started_at,
  completed_at,
  status
FROM tool_calls
WHERE session_id = ?
  AND (json_extract(input, '$.file_path') IS NOT NULL
       OR json_extract(input, '$.path') IS NOT NULL)
ORDER BY started_at ASC;
```
Then aggregate in code: group by file_path, count reads/writes/edits, compute first/last seen.

**Execution Speed — Average Latency:**
```sql
SELECT tool_name,
       AVG(completed_at - started_at) as avg_ms,
       COUNT(*) as count
FROM tool_calls
WHERE session_id = ? AND completed_at IS NOT NULL
GROUP BY tool_name
ORDER BY avg_ms DESC;
```

**Execution Speed — Slowest Ops:**
```sql
SELECT id, tool_name, input, (completed_at - started_at) as duration_ms
FROM tool_calls
WHERE session_id = ? AND completed_at IS NOT NULL
ORDER BY duration_ms DESC
LIMIT 5;
```

**Speed Sparkline** (ops in each 1-min window):
Fetch all `started_at` timestamps for the session, then bucket in code. Or use:
```sql
SELECT CAST((started_at - ?) / 60000 AS INTEGER) as minute_bucket,
       COUNT(*) as count
FROM tool_calls
WHERE session_id = ? AND started_at >= ?
GROUP BY minute_bucket
ORDER BY minute_bucket ASC;
```
Where `?` is `now - 10 minutes` in ms.

**Think vs Execute:**
```sql
SELECT started_at, completed_at
FROM tool_calls
WHERE session_id = ? AND completed_at IS NOT NULL
ORDER BY started_at ASC;
```
Then compute in code: sum of `(completed_at - started_at)` = execute time. Sum of gaps between consecutive `completed_at → next started_at` (capped at 5 min) = think time.

**Co-Touched Files:**
```sql
SELECT id, tool_name, input, started_at
FROM tool_calls
WHERE session_id = ?
  AND (json_extract(input, '$.file_path') IS NOT NULL
       OR json_extract(input, '$.path') IS NOT NULL)
ORDER BY started_at ASC;
```
Then in code: for each tool call, find other tool calls within ±30s, build co-touch pairs.

### Iteration Tracking

**Problem:** Iterations aren't persisted to the database. Two options:

**Option A (recommended):** Add an `iterations` table:
```sql
CREATE TABLE IF NOT EXISTS iterations (
  id              INTEGER NOT NULL,          -- 1-based iteration number
  session_id      TEXT NOT NULL,
  started_at      REAL NOT NULL,             -- ms timestamp
  completed_at    REAL,
  has_tool_use    INTEGER,                   -- 0 or 1
  tool_count      INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  PRIMARY KEY (session_id, id)
);
```
Persist `iteration_start`/`iteration_complete` events as they flow through the AI adapter (same place tool calls are persisted — `src/services/ai/adapter.ts`).

**Option B:** Derive from tool calls. Count distinct "bursts" of tool activity separated by gaps. Less accurate but requires no schema change.

### Churn Detection

Compute in code after loading file activity data:
- Group edit/write ops by file_path
- For each file, check if ≥ 3 ops occurred within any 60s window
- Report as churn alerts

### Scope Drift

Compute in code:
- Extract directory from each file_path
- First 20 ops establish initial directories
- Any directory from later ops not in the initial set = drift
- Drift ratio = drift dirs / total unique dirs

---

## Notification: `stats/updated`

When the ECP computes new stats (after each tool call completes), emit:
```typescript
this.sendNotification('stats/updated', {
  sessionId: string;
  // Include the full stats payload, or just a signal to re-fetch
});
```

The client can either:
- Use the notification payload directly (push model, lower latency)
- Re-call `stats/session` on notification (pull model, simpler)

**Recommendation:** Push the full payload in the notification. The client's StatsStore replaces its state wholesale. No client-side computation at all.

---

## Client Migration Plan

Once the ECP serves `stats/session`:

1. **StatsStore** becomes a passive consumer:
   - Remove all event handling, computation, and aggregation logic
   - Subscribe to `stats/updated` notifications
   - On notification: replace all published properties with the payload
   - On session load: call `stats/session` RPC to get initial state

2. **Data models stay in ultra-ui** — the structs (`FileActivity`, `ToolOperation`, `HealthSubScore`, etc.) remain but are populated from ECP responses instead of live computation.

3. **Views unchanged** — StatsContentView consumes the same StatsStore API, doesn't care where the data comes from.

---

## File Locations

| What | Where |
|------|-------|
| New RPC handler | `src/services/chat/adapter.ts` — add `stats/session` case |
| Stats computation | `src/services/chat/stats.ts` — new file, all query + aggregation logic |
| Iteration persistence | `src/services/ai/adapter.ts` — persist iteration events alongside tool calls |
| Iteration migration | `src/services/chat/migrations/` — new migration for `iterations` table |
| Notification emission | `src/services/chat/adapter.ts` — emit `stats/updated` after tool call completion |

---

## Existing Endpoint to Extend

There's already a `chat/stats` RPC (adapter.ts line ~1087) that returns simple table counts. The new `stats/session` is a session-scoped superset. Keep the existing `chat/stats` for global counts, add `stats/session` for the detailed dashboard data.

---

## Client Migration Guide (macOS & iPad)

> **Status: Server-side stats are implemented and live.** The ECP server now computes all stats from the database. Clients should migrate from local computation to consuming the ECP endpoints below.

### What the server provides

#### 1. RPC: `chat/stats/session`

Request (send over your existing ECP WebSocket connection):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "chat/stats/session",
  "params": { "sessionId": "<the chat session ID>" }
}
```

Response: the full `StatsSessionResult` object (see TypeScript interface above). Every field the Stats View needs is included — pulse, fileActivity, churnAlerts, scopeDrift, executionSpeed, iterationDepth, fileDependencies, health, toolBreakdown.

#### 2. Notification: `stats/updated`

After every tool call completes, the server pushes a notification on the **per-workspace** notification channel:

```json
{
  "jsonrpc": "2.0",
  "method": "stats/updated",
  "params": {
    "sessionId": "<session ID>",
    "stats": { /* full StatsSessionResult */ }
  }
}
```

This arrives on the same WebSocket you already receive `file/didChange`, `chat/todo/replaced`, etc. No new subscription is needed — if you're connected to the workspace, you get it.

#### 3. RPC: `chat/iteration/start` and `chat/iteration/complete`

These are called by the AI bridge automatically. **Clients do NOT need to call these.** They're listed here for completeness — the bridge persists iteration events as they happen, so stats are always up to date.

---

### Step-by-step migration

#### Phase 1: Add ECP-backed stats fetching

1. **Create a `StatsSessionResult` model** (or update the existing one) that matches the response shape above. All field names are camelCase. The server returns JSON, so decode it into your existing Swift structs. Key types:

   ```
   StatsSessionResult
   ├── pulse: Pulse
   ├── fileActivity: [FileActivity]
   ├── churnAlerts: [ChurnAlert]
   ├── scopeDrift: ScopeDrift
   ├── executionSpeed: ExecutionSpeed
   ├── iterationDepth: IterationDepth
   ├── fileDependencies: FileDependencies
   ├── health: Health
   └── toolBreakdown: [ToolBreakdownEntry]
   ```

2. **On session load** (when the user opens a chat session or resumes from background), call `chat/stats/session` with the session ID. Populate StatsStore from the response. This gives you persisted stats that survive app restart.

3. **Subscribe to `stats/updated` notifications.** In your WebSocket notification handler (the same place you handle `file/didChange`, `ai/stream/event`, etc.), add a case for `stats/updated`. When received:
   - Check `params.sessionId` matches the currently displayed session
   - Replace StatsStore's entire state with `params.stats`
   - Views will re-render automatically via your existing observation/binding mechanism

#### Phase 2: Remove client-side computation

Once ECP-backed stats are working, remove the old code:

1. **Remove event accumulation from `ai/stream/event` handler.** The StatsStore no longer needs to process individual `tool_use_started`, `tool_use_result`, `iteration_start`, `iteration_complete` events for stats purposes. (Keep forwarding them if other parts of the UI consume them, e.g. the streaming activity indicator.)

2. **Remove all computation logic from StatsStore:**
   - Tool call aggregation (counting by tool name, error rate)
   - File activity tracking (per-file read/write/edit maps)
   - Churn detection (sliding window logic)
   - Scope drift computation (initial directories, drift classification)
   - Execution speed (ops/min rolling window, sparkline bucketing, think/execute time)
   - Iteration tracking (iteration count, velocity)
   - File dependencies (co-touch pair detection, edit chain)
   - Health score computation (focus, efficiency, error, weighted average)

3. **Remove timer-based refresh.** If you have a periodic timer that recomputes stats, remove it. The server pushes updates on every tool call completion.

4. **StatsStore becomes a thin wrapper:**
   ```swift
   // Before: StatsStore computed everything from raw events
   // After:
   @Observable class StatsStore {
       var stats: StatsSessionResult?

       func load(sessionId: String) async {
           stats = try? await ecp.request("chat/stats/session", ["sessionId": sessionId])
       }

       func handleNotification(_ method: String, _ params: JSON) {
           if method == "stats/updated",
              params["sessionId"].string == currentSessionId {
               stats = StatsSessionResult(from: params["stats"])
           }
       }
   }
   ```

#### Phase 3: Verify and clean up

1. **Test with an existing session** — open a workspace that already has tool call history. Call `chat/stats/session`. You should get full stats computed from historical data. This is the key benefit: stats survive app restart.

2. **Test live updates** — start a new chat, trigger tool use, verify `stats/updated` notifications arrive and the Stats View updates in real time.

3. **Test empty session** — create a new session with no tool calls. Stats should return all zeroes/empty arrays, health level `"good"`.

4. **Remove unused models/helpers** that only existed for client-side computation (e.g. `ToolOperationTracker`, `SlidingWindowCounter`, `DirectoryClassifier`, or whatever your local equivalents are).

---

### Field mapping reference

If your existing Swift models use different names, here's the mapping from server JSON to the Stats View sections:

| Stats View Section | JSON path | Notes |
|---|---|---|
| Session Pulse | `pulse.totalOps`, `pulse.errorCount`, `pulse.errorRate`, `pulse.uniqueFileCount`, `pulse.sessionDurationMs`, `pulse.activeToolName` | `activeToolName` is null when no tool is running |
| File Activity | `fileActivity[]` | Sorted by `totalOps` desc, max 50 entries |
| Churn Alerts | `churnAlerts[]` | `windowSeconds` is always 60 |
| Scope Drift | `scopeDrift.directoryCounts`, `scopeDrift.initialDirectories`, `scopeDrift.driftDirectories`, `scopeDrift.driftRatio` | `directoryCounts` is a dict `{"/src": 5, ...}` |
| Execution Speed | `executionSpeed.*` | `speedSparkline` is always 10 elements (last 10 min) |
| Iteration Depth | `iterationDepth.*` | `iterationDurationsMs` is variable-length array |
| File Dependencies | `fileDependencies.coTouchedFiles[]`, `fileDependencies.editChain[]` | Co-touched max 20, edit chain max 30 |
| Session Health | `health.focusScore`, `health.efficiencyScore`, `health.errorScore`, `health.overallScore`, `health.level` | `level` is `"good"` / `"warning"` / `"poor"` |
| Tool Breakdown | `toolBreakdown[]` | Sorted by `count` desc |

### What NOT to change

- **Views stay the same.** `StatsContentView` and its subviews should not need structural changes. They read from StatsStore's published properties, which now come from the server instead of local computation.
- **The `ai/stream/event` notification still flows.** The server does NOT suppress it. Your streaming text view, typing indicators, etc. still work. You're just no longer using those events to _compute stats_.
- **`chat/stats` (the old simple endpoint) still works.** It returns global table counts (session count, message count, etc.). It's a different thing from `chat/stats/session`.
