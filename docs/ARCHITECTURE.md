# Muster M1 architecture and contracts

This document describes the implemented M1 server contract. JSON field names are camelCase. Unless a route says otherwise, successful REST responses are `{ "data": ... }`; errors are `{ "error": string, "details"?: ZodIssue[] }`. IDs are UUID strings and timestamps are ISO 8601 strings.

## Packages and runtime

- `packages/shared` exports the domain models, input schemas, board/phase helpers, `TurnJob`, `AgentEvent`, `TurnCompletePayload`, and `ServerEvent`.
- `apps/server` exports `createApp(options)` for embedding/tests and starts an `@hono/node-server` listener from `index.ts`.
- Node.js 22 or newer is required. The server uses built-in `node:sqlite` in synchronous WAL mode.
- `MUSTER_DATA_DIR` defaults to `~/.muster`; the database is `<data dir>/muster.db`. `PORT` defaults to `7420`; `MUSTER_PUBLIC_URL` defaults to `http://127.0.0.1:<port>`. Set `MUSTER_CHIEF_AUTO_FOLLOW_UP=false` to disable automatic Chief follow-up turns.
- If `MUSTER_ENROLL_KEY` is set, machine enrollment requires that value in `X-Muster-Enroll-Key` or a Bearer header.
- In production, `apps/web/dist` is served when it exists, with `index.html` as the SPA fallback.

The migration runner uses SQLite `user_version`; migration 1 creates the PLAN §4 tables plus these orchestration fields/tables:

- `todos.topic_id` associates Chief-created work with a topic; `todos.previous_gate` preserves Confirm/Review across revise, close, and reopen.
- `turns.session_state_json` and `turns.stop_requested` preserve runtime resume state and cooperative cancellation.
- `queued_messages.created_at` provides deterministic steer delivery order.
- `mcp_tokens` stores per-turn bearer tokens.
- A build with nullable `todo_id` and branch `chief:<topicId>` is the internal conversation container for Chief turns. Normal todo builds always have a todo and `muster/conv-<buildId>` branch.

On first start, Muster creates a `Chief` agent (`codex`, `gpt-5.6-sol`) and a `General` topic. `chief.autoFollowUp` is represented by the `createApp({autoFollowUp})` server option and defaults to true; persistent settings are deferred.

## REST API

The `{data: ...}` envelope described below applies to the web-facing `/api` routes, not the machine protocol, whose exact top-level responses are documented separately.

### Projects

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/projects` | `Project[]` |
| POST | `/api/projects` | `{name, repoUrl, baseBranch?}` → `Project` (201; branch defaults to `main`) |
| GET | `/api/projects/:id` | `Project` |
| PATCH | `/api/projects/:id` | any of `{name, repoUrl, baseBranch}` → `Project` |
| DELETE | `/api/projects/:id` | 204; returns 409 while referenced |

`Project = {id, name, repoUrl, baseBranch, createdAt}`.

### Agents

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/agents` | `Agent[]` (Chief first) |
| POST | `/api/agents` | `{name, role, runtime, model, reasoning?, avatar?}` → `Agent` (201) |
| GET | `/api/agents/:id` | `Agent` |
| PATCH | `/api/agents/:id` | any create field → `Agent` |
| DELETE | `/api/agents/:id` | 204; Chief cannot be deleted; referenced agents return 409 |

`runtime` is `codex | claude | mock`. `Agent = {id, name, role, runtime, model, reasoning: string|null, avatar: string|null, isChief, createdAt}`.

### Machines

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/machines` | `Machine[]`, augmented with `online` and `running` |
| PATCH | `/api/machines/:id` | `{concurrency: 1..64}` → `Machine` |
| DELETE | `/api/machines/:id` | 204; rejected while it owns running turns; historical assignment IDs are cleared |

`Machine = {id, name, concurrency, runtimes, lastSeenAt, createdAt, online?, running?}`. A machine is online when its last heartbeat is less than 30 seconds old.

### Todos and actions

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/todos` | `Todo[]`; filters: `phase`, `projectId`, `agentId`, `tag` |
| POST | `/api/todos` | `{projectId, title, spec?, agentId?, planAgentId?, mode?, tags?, createdBy?, topicId?}` → `Todo` (201) |
| GET | `/api/todos/:id` | `Todo & {builds: (Build & {turns: Turn[], documents: Document[]})[]}` |
| PATCH | `/api/todos/:id` | any of `{title, spec, agentId, planAgentId, tags}` → `Todo` |
| DELETE | `/api/todos/:id` | closes rather than physically deleting; 204 |
| POST | `/api/todos/:id/start` | `{mode: "plan"|"run", agentId?}` → `{turnId}` (202) |
| POST | `/api/todos/:id/confirm` | no body required → `{turnId}` (202) |
| POST | `/api/todos/:id/message` | `{content}` → `{queued, turnId?}` (202) |
| POST | `/api/todos/:id/done` | `{merge?: boolean}` → `{turnId: string|null}`; merge defaults true and returns 202, no-merge completes immediately |
| POST | `/api/todos/:id/close` | no body required → `Todo` |
| POST | `/api/todos/:id/reopen` | no body required → `Todo` |
| POST | `/api/todos/:id/rerun` | `{strategy: "continue"|"restart"}` → `{turnId}` (202) |
| POST | `/api/todos/:id/stop` | no body required → `{stopRequested:true}` (202) |

`Todo = {id, number, projectId, title, spec, phase, agentId, planAgentId, mode, tags, createdBy, topicId, previousGate, createdAt, updatedAt, doneAt}`.

`phase` is `todo | queued | planning | confirm | building | review | failed | done | closed`. Start is only valid from `todo`, confirm from `confirm`, done from `review`, rerun from `failed`, and reopen from `done`/`closed`. Invalid actions return 409. Feedback during a running turn is copied into `queued_messages`; feedback at Confirm or Review enqueues a `revise` turn and returns to the same gate after completion. Stop is cooperative: heartbeat returns the requested turn in `stop` until the daemon completes it as stopped.

### Conversations, documents, topics, and usage

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/conversations/:id/messages` | `Message[]` in creation order; ID is a build ID for todo work or topic ID for Chief chat |
| GET | `/api/todos/:id/documents` | all `Document[]` across the todo's builds |
| GET | `/api/todos/:id/documents/:kind/:version` | latest matching `Document`; kind is `plan` or `changes` |
| GET | `/api/topics` | `Topic[]` |
| POST | `/api/topics` | `{title}` → `Topic` (201) |
| GET | `/api/topics/:id` | `Topic` |
| PATCH | `/api/topics/:id` | `{title?}` → `Topic` |
| DELETE | `/api/topics/:id` | 204; returns 409 while referenced |
| POST | `/api/topics/:id/messages` | `{content}` → `{turnId}` (202), queues a Chief turn |
| GET | `/api/usage` | `{tokensIn, tokensOut, durationMs, builds, turns}` |

`Message = {id, conversationId, turnId, role, content, meta, createdAt}`. Tool start/completion events are messages with role `tool` and the complete event in `meta`. Agent deltas append to one agent message for the turn. `Document = {id, buildId, kind, version, content, createdAt}`; versions increase independently per build and kind.

## Todo orchestration

Starting creates an active build and a queued `plan` or `build` turn. Claim atomically changes the turn to running and the todo to `planning` or `building`. Successful completion maps:

| Turn | Resulting phase |
|---|---|
| `plan` | `confirm` |
| `build` | `review` |
| `revise` from Confirm | `confirm` |
| `revise` from Review | `review` |
| `merge` | `done` |

Failed/stopped turns enter `failed`, except a merge conflict/error returns the todo to `review`. Completing a turn after its todo was closed does not reopen it. `rerun:continue` keeps the active build/session lineage; `rerun:restart` creates a new build. Merge-free Done immediately marks the active build done.

When a todo enters `confirm`, `review`, `failed`, or `done`, the server appends a system message to its associated topic or the oldest/default topic. With auto-follow-up enabled, a Chief-created todo also queues a Chief turn.

Prompts combine the agent role, todo number/title/spec, optional feedback, and turn-specific instructions. Plan and Confirm-revise jobs have `readOnly:true`; build, Review-revise, and merge jobs are writable. Chief receives the PLAN §7 orchestration-only instruction.

## Machine protocol

Enrollment is the only unauthenticated machine endpoint when no enrollment key is configured. Every other request requires `Authorization: Bearer <machine token>`.

| Method | Path | Body / response data |
|---|---|---|
| POST | `/api/machine/enroll` | `{name, runtimes: Runtime[], concurrency}` → `{machineId, token}` (201) |
| POST | `/api/machine/heartbeat` | `{running: turnId[]}` → `{stop: turnId[]}` |
| POST | `/api/machine/claim` | `{}` → `TurnJob | null`; holds for up to 25 seconds in production |
| POST | `/api/machine/turns/:id/events` | `AgentEvent[]` → `{accepted: number}` |
| GET | `/api/machine/turns/:id/inbox` | `{id, content}[]`; returned rows are atomically marked delivered |
| POST | `/api/machine/turns/:id/complete` | `TurnCompletePayload` → `{accepted:true}` |

Claim selects the oldest queued turn whose selected agent runtime appears in the machine's runtime list, only while that machine's running count is below concurrency. The assignment update is conditional inside an immediate transaction, so concurrent claimers cannot both win. A running turn whose machine has not heartbeat for 30 seconds fails with `Machine went offline: no heartbeat for 30 seconds.` Offline cleanup runs during heartbeat, claim, and machine listing.

`TurnJob`:

```ts
{
  turnId: string;
  buildId: string;
  todoId: string | null; // null for Chief
  kind: "plan" | "build" | "revise" | "merge" | "chief";
  project: {id: string; repoUrl: string; baseBranch: string} | null;
  branch: string | null;
  agent: {runtime: Runtime; model: string; reasoning: string | null; role: string};
  prompt: string;
  systemInstructions: string;
  sessionState: Record<string, unknown> | null;
  readOnly: boolean;
  mcp: {url: string; token: string};
}
```

`AgentEvent` variants are:

- `{type:"message.delta", content}` and `{type:"message.completed", content?}`
- `{type:"reasoning.delta", content}`
- `{type:"tool.started", tool, callId?, input?}`
- `{type:"tool.completed", tool, callId?, output?, error?}`
- `{type:"plan.updated", content}`
- `{type:"usage", tokensIn, tokensOut}`
- `{type:"status", status, detail?}`

`TurnCompletePayload = {status:"done"|"failed"|"stopped", headCommit?, diff?, plan?, usage?:{tokensIn,tokensOut,durationMs}, error?, sessionState?, merge?:{ok,error?}}`. `plan` creates the next plan document version; a supplied `diff` (including an empty string) creates the next changes document version. Usage is accumulated on the build. Runtime state is used by later turns and also copied to the topic for Chief.

## SSE

`GET /api/events` returns `text/event-stream`. It begins with a `connected` comment, sends 15-second ping comments, and emits each event as:

```ts
{ type: string; todoId?: string; conversationId?: string; payload: unknown }
```

Entity event types are `project.changed|deleted`, `agent.changed|deleted`, `machine.changed|deleted`, `todo.created|changed`, `topic.changed|deleted`, `document.created`, `message.created`, `message.queued`, `turn.queued|started|completed|stop_requested`. Every ingested `AgentEvent.type` is also broadcast unchanged (`message.delta`, `tool.started`, and so on), with its original event in `payload`.

## MCP

`/mcp` uses the MCP SDK's stateful Streamable HTTP transport with JSON responses. It requires a per-turn Bearer token from `TurnJob.mcp.token`; tokens are accepted only while their turn is running. Clients must retain the `mcp-session-id` returned by `initialize` and send it on subsequent requests, along with the negotiated `mcp-protocol-version` header.

Tools:

| Tool | Input |
|---|---|
| `list_projects` | none |
| `list_agents` | none |
| `list_todos` | `{phase?}` |
| `get_todo` | `{todoId}` |
| `create_todo` | `{projectId,title,spec?,agentId?,planAgentId?,mode?,tags?,topicId?}`; `createdBy` is always `chief` |
| `start_todo` | `{todoId,mode,agentId?}` |
| `send_todo_message` | `{todoId,content}` |
| `confirm_plan` | `{todoId}` |
| `complete_todo` | `{todoId,merge?}` |
| `close_todo` | `{todoId}` |
| `create_agent` | `{name,role,runtime,model,reasoning?,avatar?}` |

Tool results contain a JSON text content item and `{result: value}` structured content.
