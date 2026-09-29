# AgentForEach HITL (Human-in-the-Loop) Module

This document is the implementation reference for AgentForEach's Human-in-the-Loop system.

It explains:

- Architecture (Durable Functions orchestration + Cosmos DB persistence)
- Config-driven tool gating (agentforeach.json `hitl` section)
- Wire protocol (WebSocket events between server and client)
- Session integration (shared SessionStore, conversation state, Responses API chain handling)
- Form types and resolution pipeline
- Timeout and cancellation behaviour
- How to add HITL for a new MCP server (no code changes)

## 1. Executive Summary

AgentForEach HITL is a **config-driven, fire-and-leave** system:

- The LLM generates a tool call that needs human input (e.g., "create a contact")
- The runner **pauses mid-tool-loop**, saves its state to Cosmos DB, and **exits**
- An Azure Durable Functions orchestrator **hibernates** waiting for the user's response (zero compute cost)
- The user fills a form in the client app → WebSocket message → orchestrator wakes
- The orchestrator executes the tool with merged args, saves the result to the session, and resumes the LLM

Important:

- The Azure Function **is NOT held open** while waiting for the user
- Zero compute cost during hibernation — state lives in Azure Storage
- The orchestration survives function app restarts
- Config in `agentforeach.json` controls which tools need HITL — **no code changes needed** for new MCP servers
- Uses shared `SessionStore` for all persistence — no separate conversation tracking

## 2. Component Map

Core modules:

| File | Purpose |
|------|---------|
| `hitl/types.ts` | All type definitions, constants, event names |
| `hitl/config.ts` | Loads the `hitl` section from `agentforeach.json` |
| `hitl/policy.ts` | Decides whether a tool call should be gated |
| `hitl/store.ts` | Cosmos DB persistence for `HitlRunState` |
| `hitl/orchestrator.ts` | Durable Functions orchestrator + 3 activities |
| `hitl/index.ts` | Re-exports + side-effect import for activity registration |

Integration points:

| File | Role |
|------|------|
| `client/runner.ts` | HITL gate inside the tool loop (lines ~985–1110) |
| `client/client.ts` | Exposes `_hitlStore`, `_sessionStore`, `_mcpManager` |
| `handlers/ws-message.ts` | Receives `input_response` from client, raises Durable event |
| `websocket/types.ts` | `ChatInputRequestPayload`, `ChatInputExpiredPayload` |
| `sessions/store.ts` | Shared session persistence (`appendMessages`) |
| `config/agentforeach.json` | The `hitl` configuration section |

## 3. Architecture

### 3.1 The Problem

When an LLM generates a tool call like `example_create_contact`, some tools need user confirmation or additional input before execution. Holding an HTTP request or Azure Function invocation open while waiting for a human response (which could take minutes) is wasteful and fragile.

### 3.2 The Solution: Fire and Leave, Resume on Response

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SUSPEND PATH                                │
│                                                                     │
│  User message                                                       │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────┐    tool call    ┌────────────┐    HITL gate?          │
│  │  Runner   │ ──────────────▶│  policy.ts  │ ──────────▶ Yes       │
│  │ pipeline  │                └────────────┘              │         │
│  └──────────┘                                             ▼         │
│       │                                          ┌──────────────┐   │
│       │  1. Save HitlRunState to Cosmos          │  hitlStore   │   │
│       │  2. Save user message to session         │  .create()   │   │
│       │  3. Start Durable orchestrator           └──────────────┘   │
│       │  4. Throw HitlSuspendSignal                     │           │
│       ▼                                                  │           │
│  Return "awaiting_input" ◀───────────────────────────────┘          │
│  (Azure Function exits — resources freed)                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      DURABLE ORCHESTRATOR                           │
│                                                                     │
│  HitlAwaitInput orchestration:                                      │
│       │                                                             │
│       ├── Activity: Push input_request to client (Web PubSub)       │
│       │                                                             │
│       ├── Race: waitForExternalEvent("hitl_input_response")         │
│       │         vs. createTimer(timeoutSeconds)                     │
│       │                                                             │
│       │   ┌── EVENT wins ──────────────────────────┐                │
│       │   │                                        │                │
│       │   │  Activity: HitlResumeRun               │                │
│       │   │    1. Load HitlRunState                │                │
│       │   │    2. Merge user data with LLM args    │                │
│       │   │    3. Execute MCP tool                 │                │
│       │   │    4. Save result to session           │                │
│       │   │    5. Clear previousResponseId         │                │
│       │   │    6. client.send() → full pipeline    │                │
│       │   │                                        │                │
│       │   └── Orchestration completes ─────────────┘                │
│       │                                                             │
│       │   ┌── TIMER wins ──────────────────────────┐                │
│       │   │                                        │                │
│       │   │  Activity: HitlTimeout                 │                │
│       │   │    1. Mark request as timed_out        │                │
│       │   │    2. Save timeout note to session     │                │
│       │   │    3. Send input_expired to client     │                │
│       │   │    4. NO LLM call — zero loops         │                │
│       │   │                                        │                │
│       │   └── Orchestration completes ─────────────┘                │
│       │                                                             │
│       └── ★ HIBERNATED while waiting (zero compute cost) ★          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         RESUME PATH                                 │
│                                                                     │
│  User fills form in client app                                      │
│       │                                                             │
│       ▼                                                             │
│  WebSocket message: type="input_response"                           │
│       │                                                             │
│       ▼                                                             │
│  ws-message.ts → handleInputResponse()                              │
│       │  1. Validate requestId                                      │
│       │  1b. Caller must own the request and it must be pending     │
│       │  2. Check orchestration is Running/Pending                  │
│       │  3. durableClient.raiseEvent("hitl_input_response")         │
│       ▼                                                             │
│  Orchestrator WAKES → calls HitlResumeRun activity                  │
│       │  1. Load saved state from hitlStore                         │
│       │  2. Merge user input: { ...llmArgs, ...userData }           │
│       │  3. Execute MCP tool via handleMcpToolCall()                │
│       │  4. Save tool result to session (shared SessionStore)       │
│       │  5. Clear session.conversationState (null → breaks chain)   │
│       │  6. client.send() → runner loads full history → LLM call    │
│       ▼                                                             │
│  LLM sees: user message + tool result → continues conversation      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 Key Design Decisions

1. **One-shot orchestration** — unlike the CronScheduler (which loops with `continueAsNew`), HITL orchestrations complete after the user responds or the request times out. No eternal loops.

2. **Shared session infrastructure** — the HITL module does NOT track conversation history separately. It uses the same `SessionStore.appendMessages()` that the runner uses in Step 8. The tool result is saved as a session message, and the runner loads full history on resume.

3. **Response chain clearing** — when the runner saves `previousResponseId` from the OpenAI Responses API, it enables "chain mode" where only the new message is sent to the LLM (the rest is in the chain). HITL breaks this chain because the last chained response has unresolved tool calls. The resume path clears `previousResponseId` by passing `null` to `appendMessages`, forcing the runner to send full conversation history.

4. **No LLM call on timeout** — when the timer wins the race, the `HitlTimeout` activity saves a friendly note to the session and sends `input_expired` to the client. Zero LLM calls, zero loops. The user can continue naturally in their next message.

## 4. Configuration (agentforeach.json)

All HITL behaviour is configured in the `hitl` section of `config/agentforeach.json`. No code changes are needed to add HITL for a new MCP server.

### 4.1 Top-Level Structure

```json
{
  "hitl": {
    "enabled": true,
    "defaultTimeoutSeconds": 300,
    "forms": { ... },
    "tools": { ... }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for HITL |
| `defaultTimeoutSeconds` | number | `300` | Default timeout if tool policy doesn't specify one |
| `forms` | object | `{}` | Named form definitions (reusable across tools) |
| `tools` | object | `{}` | Tool-name → policy mapping |

### 4.2 Named Forms (`hitl.forms`)

Forms define the UI that the client renders when asking for input. They're reusable — multiple tools can reference the same form.

```json
{
  "forms": {
    "create_contact": {
      "title": "Create Contact",
      "description": "Enter the details for a new contact",
      "formType": "form",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "title": "Full Name" },
          "email": { "type": "string", "title": "Email" }
        },
        "required": ["name", "email"]
      },
      "uiHints": {
        "layout": "two-column",
        "groups": [
          { "label": "Basic Information", "fields": ["name", "email"] }
        ],
        "requiredFromHuman": ["name", "email"],
        "hiddenFields": ["userId"]
      }
    },
    "choose_priority": {
      "title": "Choose Priority",
      "formType": "single_select"
    },
    "confirm_action": {
      "title": "Confirm Action",
      "formType": "confirmation"
    }
  }
}
```

A complete example (forms, tool policies for every gate mode, a custom form type) is in [`examples/hitl-forms.json`](../examples/hitl-forms.json).

### 4.3 Form Types

Five built-in form types the client must support:

| Form Type | Description | When to use |
|-----------|-------------|-------------|
| `text_input` | Single text field with optional placeholder | Free-form input (a reason, a note) |
| `confirmation` | Yes/No with preview of proposed args | "Are you sure you want to delete this?" |
| `single_select` | Pick one from a list | Choosing a priority, a template, a time slot |
| `multi_select` | Pick multiple from a list | Selecting items to include |
| `form` | Full JSON Schema form with groups and layout | Complex input like creating a contact |

Deployments can add their own types for `request_user_input` with `hitl.customFormTypes` (name → description shown to the model); the client must know how to render them.

### 4.4 UI Hints

```typescript
interface HitlUiHints {
  layout?: "single-column" | "two-column" | "wizard";
  groups?: Array<{ label: string; fields: string[] }>;
  prefilledFields?: string[];      // LLM-filled, shown as editable defaults
  requiredFromHuman?: string[];    // Highlighted, focus-first
  hiddenFields?: string[];         // Internal fields (userId, recordId)
}
```

UI hints are suggestions — the client can ignore them if its UI doesn't support the requested layout. They're merged with tool-level overrides taking precedence over form-level.

### 4.5 Tool Policies (`hitl.tools`)

Tool policies control which MCP tools get gated for human input and how.

```json
{
  "tools": {
    "example_create_contact": {
      "gate": "always",
      "form": "create_contact",
      "intent": "Create a new contact: {name}"
    },
    "example_update_record": {
      "gate": "when_args_missing",
      "intent": "Update record: {recordId}",
      "uiHints": {
        "layout": "single-column",
        "hiddenFields": ["userId"]
      }
    },
    "example_send_email": {
      "gate": "confirm_only",
      "intent": "Send this email to {to}?"
    }
  }
}
```

**Gate modes:**

| Gate | Behaviour |
|------|-----------|
| `always` | Always show the form, regardless of args |
| `when_args_missing` | Show only if required fields are missing from the LLM's proposed args |
| `confirm_only` | Show a confirmation with the LLM's proposed args |
| `never` | Explicit opt-out — tool executes immediately |

**Tool policy fields:**

| Field | Type | Description |
|-------|------|-------------|
| `gate` | string | Gate mode (required) |
| `form` | string | Named form reference from `hitl.forms` |
| `formType` | string | Inline form type (overrides the named form) |
| `intent` | string | Template with `{argName}` placeholders |
| `timeoutSeconds` | number | Override the default timeout for this tool |
| `schemaOverride` | object | JSON Schema override (takes precedence over form + MCP schema) |
| `uiHints` | object | UI hints (merged with form-level hints) |

**Glob patterns:** Tool names support simple wildcards. `example_*` matches all tools from that server. Exact matches take precedence over glob patterns.

### 4.6 Adding HITL for a New MCP Server

To add HITL for a new MCP server (e.g., a hypothetical `billing_*` server), only edit `agentforeach.json`:

```json
{
  "hitl": {
    "forms": {
      "billing_confirm": {
        "title": "Confirm Payment",
        "formType": "confirmation"
      }
    },
    "tools": {
      "billing_charge": {
        "gate": "always",
        "form": "billing_confirm",
        "intent": "Charge {amount} to {customer}?"
      },
      "billing_refund": {
        "gate": "confirm_only",
        "intent": "Refund {amount}?"
      }
    }
  }
}
```

No TypeScript changes needed. The runner's tool loop automatically checks `getHitlPolicy()` for every MCP tool call.

## 5. Data Model in Cosmos DB

### 5.1 Container: `hitl-requests`

Partition key: `/userId`

```typescript
interface HitlDocument {
  id: string;          // = requestId (UUID)
  userId: string;      // Partition key
  state: HitlRunState; // Full serializable run state
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  ttl: number;         // Cosmos TTL (seconds)
}
```

**TTL policy:**
- Pending requests: **1 hour** — if not resolved, something went wrong
- Resolved requests (responded/cancelled/timed_out): **24 hours** — kept for debugging

### 5.2 HitlRunState

The full serializable snapshot of the runner's state at the moment it paused:

```typescript
interface HitlRunState {
  requestId: string;
  orchestrationId: string;         // "hitl-{requestId}"
  originalRequest: SerializableSendRequest;
  runId: string;
  sessionId: string;
  toolRound: number;
  pendingToolCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  completedToolResults: Array<{ callId: string; output: string }>;
  independentToolCalls: Array<{ callId: string; name: string; arguments: string }>;
  conversationState: {             // Diagnostic snapshot only (see §6.3)
    previousResponseId?: string;
    containerId?: string;
    messages?: unknown[];
  };
  providerId: string;
  model: string;
  usage?: Record<string, unknown>;
  createdAt: number;
  status: "pending" | "responded" | "cancelled" | "timed_out";
}
```

### 5.3 Store Operations

| Method | Description |
|--------|-------------|
| `create(state)` | Persist a new HITL request when the runner pauses |
| `get(requestId, userId)` | Read a request by ID + partition key |
| `updateStatus(requestId, userId, status)` | Mark as responded/cancelled/timed_out, extend TTL |
| `listPending(userId)` | List all pending requests for a user |
| `cancelAllPending(userId)` | Cancel all pending requests (called on disconnect/reset) |

## 6. Session Integration

The HITL module uses the shared `SessionStore` (same module used by the runner pipeline in Step 8 of `runAgentTurn`) for all session and conversation persistence. It does NOT maintain a separate conversation tracking system.

### 6.1 Suspend Path (runner.ts)

When the runner hits a HITL gate:

1. **Saves HitlRunState** to the `hitl-requests` container (via `HitlStore.create()`)
2. **Saves the user's message** to the session via `sessionStore.appendMessages()` — this ensures the user's original message is in the session history regardless of what happens next
3. **Does NOT save `conversationState`** — the session retains its existing `conversationState` from the last fully-completed run. The current run's LLM response has pending unresolved tool calls; saving its `previousResponseId` would leave a broken Responses API chain.
4. **Starts the Durable orchestrator** (fire-and-forget)
5. **Throws `HitlSuspendSignal`** — caught by the outer error handler to return `status: "awaiting_input"`

### 6.2 Resume Path (orchestrator.ts)

When the user responds and the orchestrator wakes:

1. **Loads HitlRunState** from `hitl-requests`
2. **Merges user data** with LLM-proposed args: `{ ...llmArgs, ...userData }`
3. **Executes the MCP tool** via `handleMcpToolCall()`
4. **Saves the tool result** to the session as an assistant message via `sessionStore.appendMessages()`
5. **Clears `conversationState`** by passing `null` to `appendMessages()` — this breaks the stale Responses API chain (see §6.3)
6. **Calls `client.send()`** — the standard runner pipeline runs: load session → load message history → build prompt → call LLM → persist response → push to WebSocket

### 6.3 Why `previousResponseId` Is Cleared

The OpenAI Responses API supports **response chaining** via `previousResponseId`. When present, the runner sends only the new user message to the LLM — the Responses API server-side has the full conversation history in the chain.

HITL breaks this chain:

```
LLM Response #5 (has previousResponseId pointing to #4)
  └── Contains tool_call: example_create_contact(...)
       └── HITL gate triggers → runner SUSPENDS
           └── The tool_call in Response #5 is NEVER resolved in the chain
               └── If we keep previousResponseId → runner sends only new message
                   └── LLM sees: stale chain with dangling tool call + continuation
                       └── BROKEN: LLM has no context about the tool result
```

By clearing `previousResponseId` (passing `null` to `appendMessages`), the resume path forces the runner to send **full conversation history** from the session. The session now contains:
- The user's original message (saved during suspend)
- The tool result (saved during resume, step 4)

The LLM gets complete context naturally, through the existing session history pipeline.

> Note: `HitlRunState.conversationState` is a **diagnostic snapshot only** — it records what `previousResponseId` was at the moment of interruption for audit/debugging. The session's own `conversationState` (managed by `SessionStore`) is the authoritative source.

### 6.4 Timeout Path (orchestrator.ts)

When the timer wins the race (no user response within `timeoutSeconds`):

1. **Marks the request** as `timed_out` in the HITL store
2. **Saves a timeout note** to the session as an assistant message — provides context when the user returns
3. **Sends `input_expired`** WebSocket event to the client
4. **Does NOT call `client.send()`** — zero LLM calls, zero loops
5. When the user sends their next message, the session history has full context and the LLM can re-trigger HITL if it still needs input

### 6.5 `appendMessages` Three Modes

The shared `SessionStore.appendMessages()` supports three modes for `conversationState`:

| Value | Behaviour | When used |
|-------|-----------|-----------|
| `undefined` | Preserve existing conversationState | Suspend path (don't overwrite with stale chain) |
| `null` | Clear conversationState entirely | Resume path (break the stale chain) |
| `{ ... }` object | Merge with existing | Normal runner persistence (Step 8) |

## 7. Wire Protocol

### 7.1 Server → Client: `input_request`

Pushed via Web PubSub (`EVENTS.CHAT`) when the runner needs human input.

```typescript
type ChatInputRequestPayload = {
  state: "input_request";
  requestId: string;
  runId: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  formType: HitlFormType;
  formName?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  intent: string;
  proposedArgs: Record<string, unknown>;
  schema: Record<string, unknown>;
  uiHints?: HitlUiHints;
  timeoutSeconds: number;
};
```

### 7.2 Client → Server: `input_response`

Sent via WebSocket upstream when the user submits or cancels the form.

```typescript
type ClientInputResponseMessage = {
  type: "input_response";
  requestId: string;
  data: Record<string, unknown>;  // User's form data
  cancelled: boolean;             // true if user dismissed the form
};
```

### 7.3 Server → Client: `input_expired`

Pushed when a HITL request times out. Client should dismiss the form.

```typescript
type ChatInputExpiredPayload = {
  state: "input_expired";
  requestId: string;
  runId: string;
  sessionId: string;
  reason: string;
};
```

### 7.4 Server → Client: `awaiting_input`

The runner's `SendResponse` when it suspends for HITL (returned from the HTTP endpoint):

```typescript
{
  status: "awaiting_input",
  hitlRequestId: string,
  text: "I need some information from you before I can continue...",
  runId: string,
  sessionId: string
}
```

## 8. Policy Resolution Pipeline

When the runner encounters an MCP tool call, the policy resolution pipeline runs:

```
1. getHitlPolicy(toolName)
   ├── Is HITL enabled in config?  → No → return undefined (execute immediately)
   ├── Exact match in tools map?   → Yes → return policy (unless gate="never")
   └── Glob match (e.g. "example_*")? → Yes → return policy
                                      → No → return undefined

2. shouldGate(policy, proposedArgs, toolSchema)
   ├── gate="never"            → false
   ├── gate="always"           → true
   ├── gate="confirm_only"     → true
   └── gate="when_args_missing" → check required vs proposed → missing? → true

3. resolveIntent(policy, proposedArgs)
   └── Replace {argName} placeholders: "Create contact: {name}" → "Create contact: Ada Lovelace"

4. resolveSchema(policy, mcpToolSchema)
   └── Priority: schemaOverride > named form schema > MCP tool inputSchema > empty

5. resolveOptions(policy, proposedArgs)
   └── Priority: named form options > LLM's proposedArgs.options > undefined
```

## 9. Activity Details

### 9.1 HitlPushInputRequest

Pushes the `input_request` event to the user's connected clients via Web PubSub. Separated into an activity because orchestrator functions must be deterministic (no I/O).

### 9.2 HitlResumeRun

Resumes the agent runner after the user provides input:

1. Loads `HitlRunState` from HITL store
2. Validates state is `pending`
3. Marks as `responded`
4. If user cancelled → calls `resumeRunWithResult(client, runState, "User cancelled this action.")`
5. If user submitted → merges args, executes tool, calls `resumeRunWithResult(client, runState, toolResult)`

The `resumeRunWithResult` function:
- Saves the tool result to the session as an assistant message
- Clears `conversationState` (breaks the stale response chain)
- Calls `client.send()` which runs the full runner pipeline

### 9.3 HitlTimeout

Handles a timed-out request WITHOUT calling the LLM:

1. Marks the request as `timed_out`
2. Saves a friendly timeout note to the session
3. Sends `input_expired` to the client
4. Zero LLM calls — no loops, no unnecessary cost

## 10. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Tool execution fails during resume | Result includes error text → LLM sees it → can retry or inform user |
| Session persistence fails during suspend | Non-fatal warning — everything else still works |
| Session persistence fails during resume | Non-fatal — continuation message also carries the tool result |
| Durable event raise fails | Returns HTTP 500 to client — client can retry |
| Orchestration not found (e.g. timed out) | Returns HTTP 404 — client shows "request expired" |
| HITL store unavailable | HITL gate skipped — tool executes immediately (graceful degradation) |
| `client.send()` fails during resume | Error logged, best-effort `input_expired` pushed to client |

## 11. Sequence Diagram: Full Happy Path

```
User          Client App         Azure Function      Durable Orchestrator     Cosmos DB
  │               │                    │                     │                    │
  ├─ "New contact"┼────── WS ────────▶│                     │                    │
  │               │                    │                     │                    │
  │               │                    ├─ runAgentTurn()     │                    │
  │               │                    │  LLM returns:       │                    │
  │               │                    │  tool_call:         │                    │
  │               │                    │ example_create_contact│                    │
  │               │                    │                     │                    │
  │               │                    ├─ getHitlPolicy()    │                    │
  │               │                    │  gate="always" ✓    │                    │
  │               │                    │                     │                    │
  │               │                    ├─ Save HitlRunState ─┼────────────────────▶│
  │               │                    ├─ Save user message ─┼────────────────────▶│
  │               │                    ├─ Start orchestration ┼──────────────────▶│
  │               │                    │                     │                    │
  │               │                    ├─ Throw HitlSuspend  │                    │
  │               │◁── "awaiting_input"┤                     │                    │
  │               │                    │     ═════ EXIT ══════                    │
  │               │                    │                     │                    │
  │               │                    │                     ├─ Push input_request │
  │               │◁──── input_request ┼─────────────────────┤                    │
  │               │                    │                     │                    │
  │◁─ Show form ──┤                    │                     ├─ HIBERNATE ★       │
  │               │                    │                     │  (zero compute)    │
  │─ Fill form ──▶│                    │                     │                    │
  │               │                    │                     │                    │
  │               ├─── input_response ─▶│                     │                    │
  │               │                    ├─ raiseEvent() ──────▶│  WAKE ★           │
  │               │                    │                     │                    │
  │               │                    │                     ├─ Load HitlRunState◁┤
  │               │                    │                     ├─ Merge args        │
  │               │                    │                     ├─ Execute MCP tool  │
  │               │                    │                     ├─ Save tool result ─▶│
  │               │                    │                     ├─ Clear prevRespId ─▶│
  │               │                    │                     ├─ client.send()     │
  │               │                    │                     │  (full pipeline)   │
  │               │◁── streaming ──────┼─────────────────────┤                    │
  │               │◁── final ──────────┼─────────────────────┤                    │
  │◁─ AI response ┤                    │                     │                    │
```

## 12. Testing

Dedicated HITL tests in `hitl/hitl.test.ts` cover:

- **Config loading** — enabled/disabled, default timeout, form resolution, tool policy resolution
- **Form types** — all five built-in types resolve correctly
- **UI hints** — nested vs top-level shorthand, merge precedence
- **Gate decisions** — always, when_args_missing (with/without schema), confirm_only, never
- **Intent resolution** — template placeholders, missing args, edge cases
- **Schema resolution** — priority chain (override > form > MCP > empty)
- **Options resolution** — form options > LLM options > undefined
- **Integration** — full pipeline from tool name to resolved InputRequest fields
- **Reset** — `resetHitlConfig()` forces re-read
- **Constants** — all constants exported and distinct

Run with:
```bash
npm run build && node --test dist/gateway/hitl/hitl.test.js
```

## 13. Example Configuration

[`examples/hitl-forms.json`](../examples/hitl-forms.json) is a complete example to copy into `agentforeach.json` (which ships with only the generic `confirm_action` form and no tool policies). The `example_*` tool names are placeholders for tools your MCP servers expose:

| Tool | Gate | Form | Intent |
|------|------|------|--------|
| `example_create_contact` | always | create_contact | "Create a new contact: {name}" |
| `example_update_record` | when_args_missing | (inline) | "Update record: {recordId}" |
| `example_set_priority` | always | choose_priority | "Set priority for task: {taskId}" |
| `example_send_email` | confirm_only | confirm_action | "Send this email to {to}?" |
| `example_delete_*` | confirm_only | (inline) | "Delete this item? This cannot be undone." |

3 named forms: `create_contact`, `choose_priority`, `confirm_action` (from [`examples/hitl-forms.json`](../examples/hitl-forms.json)).
