# AgentForEach HITL (Human-in-the-loop) module

This document is the implementation reference for AgentForEach's Human-in-the-Loop system.

It explains:

- Architecture (a durable wait + Cosmos DB persistence)
- Config-driven tool gating (agentforeach.json `hitl` section)
- Wire protocol (WebSocket events between server and client)
- Session integration (shared SessionStore, conversation state, Responses API chain handling)
- Form types and resolution pipeline
- Timeout and cancellation behaviour
- How to add HITL for a new MCP server (no code changes)

## 1. Executive summary

AgentForEach HITL is a **config-driven, fire-and-leave** system:

- The LLM generates a tool call that needs human input (e.g., "create a contact")
- The runner **pauses mid-tool-loop**, saves its state to Cosmos DB, and **exits**
- A durable wait (`HitlAwaitInput`, see [Platforms](Platforms.md); on Azure a `DurableWait` orchestration) **hibernates** waiting for the user's response (zero compute cost)
- The user fills a form in the client app → WebSocket message → the wait wakes
- The wait's event handler executes the tool with merged args, saves the result to the session, and resumes the LLM

Important:

- The function invocation **is not held open** while waiting for the user
- Zero compute cost during hibernation: on Azure the wait's state lives in the Durable Functions task hub (Azure Storage)
- The wait survives function app restarts
- Only web and app chat turns can pause for a form (`executeChatTurn` sets `request.canSuspendForInput`), and only when a Durable is installed. Channel, cron and resumed turns refuse a gated tool instead (§10)
- Config in `agentforeach.json` controls which tools need HITL, so new MCP servers need **no code changes**
- Uses the shared `SessionStore` for all persistence, with no separate conversation tracking

## 2. Component map

Core modules:

| File | Purpose |
|------|---------|
| `hitl/types.ts` | All type definitions, constants, event names |
| `hitl/config.ts` | Loads the `hitl` section from `agentforeach.json` |
| `hitl/policy.ts` | Decides whether a tool call should be gated |
| `hitl/store.ts` | Cosmos DB persistence for `HitlRunState` |
| `hitl/orchestrator.ts` | The `HitlAwaitInput` durable wait (`hitlWait`): start, event and timeout handlers |
| `hitl/answer.ts` | `answerInputRequest`: saves an answer, then delivers it, for every client path (§7.2) |
| `hitl/recovery.ts` | What `GET /api/hitl/pending` and `GET /api/hitl/{id}` return (§7.5) |
| `hitl/index.ts` | Re-exports |

Integration points:

| File | Role |
|------|------|
| `workflows.ts` | Registers `hitlWait` with the gateway's other durable kinds |
| `client/runner.ts` | HITL gate inside the tool loop (around the `hitlGateAction` call) |
| `handlers/chat-turn.ts` | `executeChatTurn` sets `canSuspendForInput`, so only its turns can pause for a form |
| `client/client.ts` | Exposes `_hitlStore`, `_sessionStore`, `_mcpManager` |
| `handlers/client-events.ts` | Receives `input_response` from the client (via `ws-message.ts`), answers it with `answerInputRequest` |
| `handlers/api.ts` | `POST /api/chat` with `hitlInputResponse` (`answerInputRequest`), and the two recovery routes (§7.5) |
| `websocket/types.ts` | `ChatInputRequestPayload`, `ChatInputExpiredPayload` |
| `sessions/store.ts` | Shared session persistence (`appendMessages`) |
| `config/agentforeach.json` | The `hitl` configuration section |

## 3. Architecture

### 3.1 The problem

When an LLM generates a tool call like `example_create_contact`, some tools need user confirmation or additional input before execution. Holding an HTTP request or Azure Function invocation open while waiting for a human response (which could take minutes) is wasteful and fragile.

### 3.2 The solution: fire and leave, resume on response

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
│       │  3. Start HitlAwaitInput wait            └──────────────┘   │
│       │  4. Throw HitlSuspendSignal                     │           │
│       ▼                                                  │           │
│  Return "awaiting_input" ◀───────────────────────────────┘          │
│  (invocation exits — resources freed)                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         DURABLE WAIT                                │
│                                                                     │
│  HitlAwaitInput wait:                                               │
│       │                                                             │
│       ├── start: Push input_request to client (Web PubSub)          │
│       │                                                             │
│       ├── Race: event "hitl_input_response"                         │
│       │         vs. timeout (timeoutSeconds)                        │
│       │                                                             │
│       │   ┌── EVENT wins ──────────────────────────┐                │
│       │   │                                        │                │
│       │   │  onEvent: resumeAfterInput             │                │
│       │   │    1. Load HitlRunState                │                │
│       │   │    2. Merge user data with LLM args    │                │
│       │   │    3. Execute MCP tool                 │                │
│       │   │    4. Save result to session           │                │
│       │   │    5. Clear previousResponseId         │                │
│       │   │    6. client.send() → full pipeline    │                │
│       │   │                                        │                │
│       │   └── Wait completes ──────────────────────┘                │
│       │                                                             │
│       │   ┌── TIMEOUT first ───────────────────────┐                │
│       │   │                                        │                │
│       │   │  onTimeout: expireInputRequest         │                │
│       │   │    1. Mark request as timed_out        │                │
│       │   │    2. Save timeout note to session     │                │
│       │   │    3. Send input_expired to client     │                │
│       │   │    4. NO LLM call — zero loops         │                │
│       │   │                                        │                │
│       │   └── Wait completes ──────────────────────┘                │
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
│  client-events.ts → handleInputResponse()                           │
│       │  1. Validate requestId                                      │
│       │  1b. Caller must own the request and it must be pending     │
│       │  2. durable().signal("hitl-{id}", "hitl_input_response")    │
│       │  3. Not delivered (wait not running) → 404                  │
│       ▼                                                             │
│  Wait WAKES → runs onEvent (resumeAfterInput)                       │
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

### 3.3 Key design decisions

1. **One-shot wait**: unlike the CronScheduler (a durable alarm that ticks forever), a HITL wait completes after the user responds or the request times out. No eternal loops.

2. **Shared session infrastructure**: the HITL module does not track conversation history separately. It uses the same `SessionStore.appendMessages()` that the runner uses in Step 8. The tool result is saved as a session message, and the runner loads full history on resume.

3. **Response chain clearing**: when the runner saves `previousResponseId` from the OpenAI Responses API, it enables "chain mode" where only the new message is sent to the LLM (the rest is in the chain). HITL breaks this chain because the last chained response has unresolved tool calls. The resume path clears `previousResponseId` by passing `null` to `appendMessages`, forcing the runner to send full conversation history.

4. **No LLM call on timeout**: when the timeout passes first, the timeout handler (`expireInputRequest`) saves a friendly note to the session and sends `input_expired` to the client. Zero LLM calls, zero loops. The user can continue in their next message.

## 4. Configuration (agentforeach.json)

All HITL behaviour is configured in the `hitl` section of `config/agentforeach.json`. No code changes are needed to add HITL for a new MCP server.

### 4.1 Top-level structure

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

### 4.2 Named forms (`hitl.forms`)

Forms define the UI that the client renders when asking for input. They're reusable: multiple tools can reference the same form.

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

### 4.3 Form types

Five built-in form types the client must support:

| Form Type | Description | When to use |
|-----------|-------------|-------------|
| `text_input` | Single text field with optional placeholder | Free-form input (a reason, a note) |
| `confirmation` | Yes/No with preview of proposed args | "Are you sure you want to delete this?" |
| `single_select` | Pick one from a list | Choosing a priority, a template, a time slot |
| `multi_select` | Pick multiple from a list | Selecting items to include |
| `form` | Full JSON Schema form with groups and layout | Complex input like creating a contact |

Deployments can add their own types for `request_user_input` with `hitl.customFormTypes` (name → description shown to the model); the client must know how to render them.

The browser's handoff pauses the run on a `browser_handoff` form, answered like any other (`hitlInputResponse` with `{ data: { done: true } }` or `cancelled`). Its `proposedArgs.viewerUrl` is the live view of the agent's browser for the client to embed; see [Browser.md](Browser.md#handing-the-browser-to-the-user).

### 4.4 UI hints

```typescript
interface HitlUiHints {
  layout?: "single-column" | "two-column" | "wizard";
  groups?: Array<{ label: string; fields: string[] }>;
  prefilledFields?: string[];      // LLM-filled, shown as editable defaults
  requiredFromHuman?: string[];    // Highlighted, focus-first
  hiddenFields?: string[];         // Internal fields (userId, recordId)
}
```

UI hints are suggestions: the client can ignore them if its UI doesn't support the requested layout. They're merged, with tool-level overrides taking precedence over form-level.

### 4.5 Tool policies (`hitl.tools`)

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
| `never` | Explicit opt-out: the tool executes immediately |

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

### 4.6 Adding HITL for a new MCP server

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

## 5. Data model in Cosmos DB

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
- Pending requests: the request's timeout plus **10 minutes**, and at least **1 hour**, so an answer (or the timeout) always finds the state
- When a gated call pauses the run, the other calls from the same response get up to **10 seconds** to finish; their results are saved with the request and written into the history on resume or timeout
- Resolved requests (responded/cancelled/timed_out/failed): **24 hours**, kept for debugging and for `GET /api/hitl/{id}` (§7.5)

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
  status: "pending" | "responded" | "cancelled" | "timed_out" | "failed";
  inputRequest?: InputRequestPayload;  // The form as the client received it (§7.5)
  answer?: {                           // The user's answer, saved before it is delivered (§7.2)
    data: Record<string, unknown>;
    cancelled: boolean;
    answeredAt: string;                // ISO 8601
  };
  resumedRunId?: string;               // The run that continued after the answer, once finished
}
```

`failed`: the user answered, but the run didn't continue (the resume was cut off, or its turn failed).

### 5.3 Store operations

| Method | Description |
|--------|-------------|
| `create(state)` | Persist a new HITL request when the runner pauses |
| `get(requestId, userId)` | Read a request by ID + partition key |
| `transition(requestId, userId, update)` | One guarded write (an etag): `update` sees the latest state and returns the next one, or nothing. Saving an answer, a resume's claim and the continuation's outcome all go through it |
| `updateStatus(requestId, userId, status, fields?)` | Move a **pending** request to responded/cancelled/timed_out (a request already resolved isn't changed), extend TTL; returns whether it changed |
| `listPending(userId)` | List all pending requests for a user |
| `cancelAllPending(userId)` | Cancel all pending requests (called on disconnect/reset) |

## 6. Session integration

The HITL module uses the shared `SessionStore` (same module used by the runner pipeline in Step 8 of `runAgentTurn`) for all session and conversation persistence. It does not maintain a separate conversation tracking system.

### 6.1 Suspend path (runner.ts)

When the runner hits a HITL gate:

1. **Saves HitlRunState** to the `hitl-requests` container (via `HitlStore.create()`)
2. **Saves the user's message** to the session via `sessionStore.appendMessages()`, so the user's original message is in the session history regardless of what happens next
3. **Does not save `conversationState`**: the session retains its existing `conversationState` from the last fully-completed run. The current run's LLM response has pending unresolved tool calls; saving its `previousResponseId` would leave a broken Responses API chain.
4. **Starts the `HitlAwaitInput` durable wait** (id `hitl-{requestId}`, timing out after `timeoutSeconds`); its start handler pushes the form
5. **Throws `HitlSuspendSignal`**, which the outer error handler catches to return `status: "awaiting_input"`

### 6.2 Resume path (orchestrator.ts)

When the user responds and the wait wakes:

1. **Loads HitlRunState** from `hitl-requests`
2. **Merges user data** with LLM-proposed args: `{ ...llmArgs, ...userData }`
3. **Executes the MCP tool** via `handleMcpToolCall()`
4. **Saves the tool result** to the session as an assistant message via `sessionStore.appendMessages()`
5. **Clears `conversationState`** by passing `null` to `appendMessages()`, which breaks the stale Responses API chain (see §6.3)
6. **Calls `client.send()`**, which runs the standard runner pipeline: load session → load message history → build prompt → call LLM → persist response → push to WebSocket

### 6.3 Why `previousResponseId` is cleared

The OpenAI Responses API supports **response chaining** via `previousResponseId`. When present, the runner sends only the new user message to the LLM, because the Responses API holds the full conversation history server-side in the chain.

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

The LLM gets complete context through the existing session history pipeline.

> `HitlRunState.conversationState` is a **diagnostic snapshot only**. It records what `previousResponseId` was at the moment of interruption for audit/debugging. The session's own `conversationState` (managed by `SessionStore`) is the authoritative source.

### 6.4 Timeout path (orchestrator.ts)

When the timeout passes first (no user response within `timeoutSeconds`):

1. **Marks the request** as `timed_out` in the HITL store
2. **Saves a timeout note** to the session as an assistant message, which gives context when the user returns
3. **Sends `input_expired`** WebSocket event to the client
4. **Does not call `client.send()`**: zero LLM calls, zero loops
5. When the user sends their next message, the session history has full context and the LLM can re-trigger HITL if it still needs input

### 6.5 `appendMessages` three modes

The shared `SessionStore.appendMessages()` supports three modes for `conversationState`:

| Value | Behaviour | When used |
|-------|-----------|-----------|
| `undefined` | Preserve existing conversationState | Suspend path (don't overwrite with stale chain) |
| `null` | Clear conversationState entirely | Resume path (break the stale chain) |
| `{ ... }` object | Merge with existing | Normal runner persistence (Step 8) |

## 7. Wire protocol

### 7.1 Server → client: `input_request`

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

### 7.2 Client → server: `input_response`

Sent via WebSocket upstream when the user submits or cancels the form.

```typescript
type ClientInputResponseMessage = {
  type: "input_response";
  requestId: string;
  data: Record<string, unknown>;  // User's form data
  cancelled: boolean;             // true if user dismissed the form
};
```

Or over HTTP, for clients that send nothing over the socket: `POST /api/chat` with `hitlInputResponse: { requestId, data | cancelled }`. Either way answers every kind of form:

- **A gated tool's form** (an MCP tool that asks first) is answered by signalling its durable wait, which resumes the run. Over HTTP the answer gets `202 { status: "accepted", resumed: true, requestId }`, and no new turn starts: the chat message sent with it isn't used.
- **A form the model raised** (`request_user_input`, a browser handoff) is answered by the chat turn that carries it, which resumes the response that asked. Over the socket, `input_response` for such a form gets a 404 saying to answer it with a chat request.

Only the user a form belongs to can answer it, and only while it's pending; anything else is not found.

Both paths go through `answerInputRequest` (`hitl/answer.ts`), which **saves the answer first**: before anything is delivered, the answer (`data`, `cancelled`, `answeredAt`) is written on the request with a guarded store write (`HitlStore.transition`), and the first answer saved is the one that counts.

| The answer | Outcome | Over HTTP | Over the socket |
|---|---|---|---|
| The first answer to a pending request | Saved, then delivered (a gated tool's wait is signalled; a model-raised form is left to the chat turn) | `202 { resumed: true }`, or the chat turn | `200 { ok: true }`, or 404 "answer with a chat request" |
| The same answer again (equal `data` and `cancelled`) | The outcome the first got. A gated tool's wait is signalled again only while it hasn't taken the answer, which is harmless | as the first | as the first |
| A different answer to an answered request | `conflict`; nothing is delivered | `409 { error, requestId }` | `409 { error }` |
| Another user's request, one that was resolved without an answer (timed out, cancelled by a new message), or none | `not_found` | the message runs as a new turn, as before | 404 |

The wait's resume reads the saved answer, not the event that delivered it, so a re-delivered or altered event can't change what the user answered. An answer saved before the deadline wins, even if the timeout fires first: when the signal is refused while the wait is still running, the answer is accepted (`resumed`), and the timeout resumes the run with it instead of expiring the form. A model-raised form's answer is saved too (for §7.5); the chat turn that carries it resumes the response as before.

### 7.3 Server → client: `input_expired`

Pushed when a HITL request times out. The client should dismiss the form.

```typescript
type ChatInputExpiredPayload = {
  state: "input_expired";
  requestId: string;
  runId: string;
  sessionId: string;
  reason: string;
};
```

### 7.4 Server → client: `awaiting_input`

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

### 7.5 Recovering forms after a reconnect

A form reaches the client once, as an `input_request` event. A client that was offline when it was pushed, or reconnects, asks again. Both routes are part of the shared gateway, so every cloud serves them; both need the user's sign-in, read the store partition-scoped to that user, and answer with `Cache-Control: no-store`.

**`GET /api/hitl/pending`**: the signed-in user's forms still waiting for an answer (pending, not answered, and before their timeout), newest first, each as the `input_request` event that showed it, plus when it expires:

```typescript
{
  requests: Array<{
    state: "input_request";
    requestId: string;
    runId: string;
    sessionId: string;
    toolName: string;
    toolCallId: string;
    formType: HitlFormType;
    formName?: string;
    intent: string;
    proposedArgs: Record<string, unknown>;
    schema?: Record<string, unknown>;   // always for a gated tool's form
    options?: Array<{ label: string; value: string; description?: string }>;
    uiHints?: HitlUiHints;
    timeoutSeconds: number;
    expiresAt: string;                  // ISO 8601: creation + timeoutSeconds
  }>;
}
```

A client renders them as it renders the event, and answers them the usual way (§7.2). Requests saved before the form was stored with them (`HitlRunState.inputRequest`) aren't listed.

**`GET /api/hitl/{id}`**: where one request is. Another user's request, or none, is a 404.

```typescript
{
  requestId: string;
  status: "pending" | "responded" | "expired" | "cancelled" | "failed";
  sessionId: string;
  runId: string;           // the run that asked
  answeredAt?: string;     // when the answer was accepted
  resumedRunId?: string;   // the run that continued after the answer, once it has finished
}
```

`expired` is a request that timed out, or a pending one past its timeout that nobody answered. `cancelled` is a cancel answer, or a model-raised form the user moved past with a new message. `failed`: the answer was accepted, but the run didn't continue. After a `202 { resumed: true }`, a client polls this until `resumedRunId` appears, then shows that run's reply from `GET /api/sessions/{sessionId}` (by `runId`); `examples/web-chat` does (`recoverApproval`). For a model-raised form, `resumedRunId` is the chat turn that carried the answer. A gated tool's continuation is a run like any other: it has a status record (`GET /api/chat/runs/{runId}`) from the moment it starts, so a client that saw its events can follow it there before `resumedRunId` appears. If the session was busy, each attempt is its own run, and `resumedRunId` names the one that ran.

Both routes answer 503 when no HITL store is configured.

## 8. Policy resolution pipeline

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

## 9. Handler details

The wait's three handlers are in `hitl/orchestrator.ts`. On Azure they run as the `DurableWaitStart`, `DurableWaitEvent` and `DurableWaitTimeout` activities of a `DurableWait` orchestration. Waits started before the durable port finish on the old `HitlAwaitInput` orchestration (activities `HitlPushInputRequest`, `HitlResumeRun`, `HitlTimeout`), kept registered for one release (`packages/platform-azure/src/durable/legacy.ts`).

### 9.1 start: `pushInputRequest`

Pushes the `input_request` event to the user's connected clients via Web PubSub. Runs once when the wait begins, before it sleeps.

### 9.2 onEvent: `resumeAfterInput`

Resumes the agent runner after the user provides input:

1. Loads `HitlRunState` from HITL store, and takes the answer saved on it (§7.2); the delivered event is used only for a request answered before answers were saved
2. Claims the request: moves it from `pending` to `responded` (or `cancelled`) with a guarded write; a request no longer pending isn't resumed again
3. If user cancelled → calls `resumeRunWithResult(client, runState, "User cancelled this action.")`
4. If user submitted → merges args, executes tool, calls `resumeRunWithResult(client, runState, toolResult)`
5. Records the continuation's run id (`resumedRunId`), or `failed` when it failed (§7.5)

The `resumeRunWithResult` function:
- Saves the tool result to the session as an assistant message
- Clears `conversationState` (breaks the stale response chain)
- Calls `client.send()` which runs the full runner pipeline

### 9.3 onTimeout: `expireInputRequest`

Handles a timed-out request without calling the LLM:

1. Marks the request as `timed_out`, only if it is pending and unanswered. A request resolved in time is left alone; one with a saved answer (the signal lost the race with the timeout) is resumed with that answer, as `onEvent` would (§9.2), and nothing below happens
2. Saves a friendly timeout note to the session
3. Sends `input_expired` to the client
4. Zero LLM calls: no loops, no unnecessary cost

## 10. Error handling

| Scenario | Behaviour |
|----------|-----------|
| Tool execution fails during resume | Result includes error text → LLM sees it → can retry or inform user |
| Session persistence fails during suspend | Non-fatal warning; everything else still works |
| Session persistence fails during resume | Non-fatal: the continuation message also carries the tool result |
| Delivering the answer fails (`durable().signal` throws) | Returns HTTP 500 to the client, which can retry |
| Wait not running (e.g. timed out) | Returns HTTP 404; the client shows "request expired" |
| A second, different answer to an answered form | Returns HTTP 409; the first answer stands |
| Turn can't suspend (channel, cron or resumed turn; no HITL store; no Durable installed) | The gated tool is refused: the model is told the action needs the user's approval in the app |
| `client.send()` fails during resume | Error logged, best-effort `error` event pushed to client; the request is recorded `failed` |

## 11. Sequence diagram: full happy path

```
User          Client App         Gateway             Durable Wait             Cosmos DB
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
  │               │                    ├─ Start durable wait ─┼──────────────────▶│
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
  │               │                    ├─ signal() ──────────▶│  WAKE ★           │
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

- **Config loading**: enabled/disabled, default timeout, form resolution, tool policy resolution
- **Form types**: all five built-in types resolve correctly
- **UI hints**: nested vs top-level shorthand, merge precedence
- **Gate decisions**: always, when_args_missing (with/without schema), confirm_only, never
- **Intent resolution**: template placeholders, missing args, edge cases
- **Schema resolution**: priority chain (override > form > MCP > empty)
- **Options resolution**: form options > LLM options > undefined
- **Integration**: full pipeline from tool name to resolved InputRequest fields
- **Reset**: `resetHitlConfig()` forces re-read
- **Constants**: all constants exported and distinct

Run with:
```bash
npm run build && node --test dist/gateway/hitl/hitl.test.js
```

## 13. Example configuration

[`examples/hitl-forms.json`](../examples/hitl-forms.json) is a complete example to copy into `agentforeach.json` (which ships with only the generic `confirm_action` form and no tool policies). The `example_*` tool names are placeholders for tools your MCP servers expose:

| Tool | Gate | Form | Intent |
|------|------|------|--------|
| `example_create_contact` | always | create_contact | "Create a new contact: {name}" |
| `example_update_record` | when_args_missing | (inline) | "Update record: {recordId}" |
| `example_set_priority` | always | choose_priority | "Set priority for task: {taskId}" |
| `example_send_email` | confirm_only | confirm_action | "Send this email to {to}?" |
| `example_delete_*` | confirm_only | (inline) | "Delete this item? This cannot be undone." |

3 named forms: `create_contact`, `choose_priority`, `confirm_action` (from [`examples/hitl-forms.json`](../examples/hitl-forms.json)).
