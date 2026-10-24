# Muster architecture and contracts (M4)

This document describes the integrated server, daemon, and web contract. JSON field names are camelCase. Unless a route says otherwise, successful REST responses are `{ "data": ... }`; errors are `{ "error": string, "details"?: ZodIssue[] }`. IDs are UUID strings and timestamps are ISO 8601 strings.

## Packages and runtime

- `packages/shared` exports the domain models, input schemas, board/phase helpers, `TurnJob`, `AgentEvent`, `TurnCompletePayload`, and `ServerEvent`.
- `apps/server` exports `createApp(options)` for embedding/tests and starts an `@hono/node-server` listener from `index.ts`.
- Node.js 22 or newer is required. The server uses built-in `node:sqlite` in synchronous WAL mode.
- `MUSTER_DATA_DIR` defaults to `~/.muster`; the database is `<data dir>/muster.db`. `HOST` defaults to `127.0.0.1`, `PORT` defaults to `7420`; `MUSTER_PUBLIC_URL` defaults to `http://127.0.0.1:<port>`. `MUSTER_CLAIM_WAIT_MS` controls long-poll duration (default 25000). Set `MUSTER_CHIEF_AUTO_FOLLOW_UP=false` to disable automatic Chief follow-up turns.
- If `MUSTER_ENROLL_KEY` is set, machine enrollment requires that value in `X-Muster-Enroll-Key` or a Bearer header.
- In production, `apps/web/dist` is served when it exists, with `index.html` as the SPA fallback.

The migration runner uses SQLite `user_version`; migration 1 creates the PLAN §4 tables plus these orchestration fields/tables:

- `todos.topic_id` associates Chief-created work with a topic; `todos.previous_gate` preserves Confirm/Review across revise, close, and reopen.
- `turns.session_state_json` and `turns.stop_requested` preserve runtime resume state and cooperative cancellation.
- `queued_messages.created_at` provides deterministic steer delivery order.
- `mcp_tokens` stores per-turn bearer tokens.
- A build with nullable `todo_id` and branch `chief:<topicId>` is the internal conversation container for Chief turns. Normal todo builds always have a todo and `muster/conv-<buildId>` branch.

On first start, Muster creates a `Chief` agent (`codex`, `gpt-6.1-sol`) and a `General` topic. `chief.autoFollowUp` is represented by the `createApp({autoFollowUp})` server option and defaults to true; persistent settings are deferred. Shared `DEFAULT_MODELS` defines Codex `gpt-6.1-sol`, Claude `claude-sonnet-5-5`, and Mock `mock`; the web agent editor uses the same defaults. Existing explicitly configured agents are preserved.

Migration 2 adds per-turn immutable agent/model snapshots, duration, heartbeat leases, and idempotent completion bodies. `event_batches` deduplicates uploads, `machine_claims` recovers claim responses, and `server_events` persists SSE replay. Queued messages link to their source user message and record an in-flight delivery turn. `schema.sql` is a current-schema reference; `migrations.ts` is executed on startup.

## Local commands

- `npm install` installs all workspaces and prepares the daemon binary.
- `npm run dev` builds shared and starts server on 7420 plus Vite on 5173 concurrently. It stops both processes on interruption or a child failure. Watchers use polling by default; `CHOKIDAR_USEPOLLING=false` opts into native watching.
- `npm run daemon` builds shared and daemon, then starts against `http://127.0.0.1:7420`; extra flags such as `-- --concurrency 2` are forwarded. `MUSTER_HOME` controls the daemon's registration and workspaces; `MUSTER_DATA_DIR` controls server data.
- `npm run build && npm start` serves the built web app and API from 7420. Static paths resolve relative to the server module, independent of launch cwd.
- `npm run e2e` expects built packages. It starts a child server with an isolated `MUSTER_DATA_DIR` on an ephemeral port and a mock-only daemon. It verifies a real local Git merge, mid-turn steer delivery, concurrent isolated worktrees, Chief MCP delegation, production SPA routes, and SSE replay. All temporary data and processes are cleaned up.
- Vite proxies `/api` (including SSE) and `/mcp` to 7420. Remote daemons require a reachable `MUSTER_PUBLIC_URL`; set `HOST` explicitly to bind beyond loopback.

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

`phase` is `todo | queued | planning | confirm | building | review | failed | done | closed`. Start is only valid from `todo`, confirm from `confirm`, done from `review`, rerun from `failed`, and reopen from `done`/`closed`. Invalid actions return 409. Feedback during a running turn is copied into `queued_messages`; feedback at Confirm or Review enqueues a `revise` turn and returns to the same gate after completion. Stop is cooperative for running work: heartbeat returns the requested turn in `stop` until the daemon completes it as stopped. A queued stop cancels immediately into `failed`. Reopen waits until a closed running turn has acknowledged its stop. Invalid feedback leaves no messages or builds behind; feedback may also be queued before claim.

### Conversations, documents, topics, and usage

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/conversations/:id/messages` | `Message[]` in creation order; ID is a build ID for todo work or topic ID for Chief chat |
| GET | `/api/todos/:id/documents` | all `Document[]` across the todo's builds |
| GET | `/api/todos/:id/documents/:kind/:version` | latest matching `Document`; kind is `plan` or `changes` |
| GET | `/api/topics` | `Topic[]` (includes persisted `activity` and `activeTurnId`) |
| POST | `/api/topics` | `{title}` → `Topic` (201) |
| GET | `/api/topics/:id` | `Topic` |
| PATCH | `/api/topics/:id` | `{title?}` → `Topic` |
| DELETE | `/api/topics/:id` | 204; returns 409 while referenced |
| POST | `/api/topics/:id/messages` | `{content}` → `{turnId}` (202), queues a Chief turn |
| GET | `/api/usage` | `UsageReport`: `{tokensIn, tokensOut, durationMs, builds, turns, entries}` |

`Message = {id, conversationId, turnId, role, content, meta, createdAt}`. Every message includes its true `turnId`, creation timestamp, and a monotonic `meta.revision`. Tool start/completion events are messages with role `tool` and the complete event in `meta`. Agent deltas append to one agent message for the turn. `Document = {id, buildId, kind, version, content, createdAt}`; versions increase independently per build and kind.

### Queued steering and usage

- `GET /api/conversations/:id/queued-messages` returns pending `QueuedMessage[]`: `{id, conversationId, content, createdAt, deliveredAt:null, delivering}`.
- `PATCH /api/conversations/:id/queued-messages/:messageId` with `{content}` edits undelivered, unreserved feedback; `DELETE` retracts it (204). Edits and retractions also update the source user message in conversation history. In-flight or delivered messages return 409, avoiding an edit racing runtime delivery.
- Inbox GET reserves delivery but does not consume the message. Only an explicit ACK removes it from the pending tray. A terminal turn releases unacknowledged reservations, so feedback remains available for a later turn. The server emits `message.queue_changed` and `message.delivered` events.
- Usage entries identify the actual turn/build, todo or Chief topic, agent ID/name, runtime, model, start time (UTC), input/output tokens, and duration. Agent/model values come from claim-time snapshots, so edits to an agent do not rewrite history. Both totals and entries cover terminal turns, including Chief and offline failures. `builds` and `turns` count all records. Historical M1 turns without snapshots report unknown agent/model and `runtime:null`.
- Chief topic `activity` (`idle|queued|running`) and `activeTurnId` are derived from persisted turns, and survive refresh and server restart. Unread markers remain browser-session state.

## Todo orchestration

Starting creates an active build and a queued `plan` or `build` turn. Claim atomically changes the turn to running and the todo to `planning` or `building`. Successful completion maps:

| Turn | Resulting phase |
|---|---|
| `plan` | `confirm` |
| `build` | `review` |
| `revise` from Confirm | `confirm` |
| `revise` from Review | `review` |
| `merge` | `done` |

Failed/stopped turns enter `failed`, except a merge conflict/error or offline merge returns the todo to `review`. A merge requires explicit `{merge:{ok:true}}` confirmation before Done. Completing a turn after its todo was closed does not reopen it. `rerun:continue` keeps the active build/session lineage; `rerun:restart` creates a new build and branch with no runtime session. Both retain the failed request, including revision feedback. Accepted plan text is included explicitly in build prompts, including when plan/build use different agents or a restart creates a new conversation. Merge-free Done immediately marks the active build done.

When a todo enters `confirm`, `review`, `failed`, or `done`, the server appends a system message to its associated topic or the oldest/default topic. With auto-follow-up enabled, a Chief-created todo also queues a Chief turn.

Prompts combine the agent role, todo number/title/spec, optional feedback, and turn-specific instructions. Plan and Confirm-revise jobs have `readOnly:true`; build, Review-revise, and merge jobs are writable. Chief receives the PLAN §7 orchestration-only instruction.

## Machine protocol

Enrollment is the only unauthenticated machine endpoint when no enrollment key is configured. Every other request requires `Authorization: Bearer <machine token>`.

| Method | Path | Body / response data |
|---|---|---|
| POST | `/api/machine/enroll` | `{name, runtimes: Runtime[], concurrency}` → `{machineId, token}` (201) |
| POST | `/api/machine/heartbeat` | `{running: turnId[]}` → `{stop: turnId[]}` |
| POST | `/api/machine/claim` | `{requestId?:string}` → `TurnJob | null`; holds for up to 25 seconds in production |
| POST | `/api/machine/turns/:id/events` | `{batchId:string, events:AgentEvent[]}` → `{accepted: number}` |
| GET | `/api/machine/turns/:id/inbox` | `{id, content}[]`; non-destructive, reserved for this turn until ACK |
| POST | `/api/machine/turns/:id/inbox/ack` | `{ids:string[]}` → `{accepted:true}`; acknowledges runtime acceptance |
| POST | `/api/machine/turns/:id/complete` | `TurnCompletePayload` → `{accepted:true}` |

Claim selects the oldest compatible queued turn while respecting machine concurrency and at most one running turn per build (including Chief conversations), inside one immediate SQLite transaction. Builds stay pinned to their first machine because worktrees and runtime sessions are local. A continued build waits for that machine; restart creates a fresh build that any compatible machine may claim.

The daemon supplies a fresh `requestId` for each logical claim and retries transport failures with that same ID. A repeated ID returns the original running job and MCP token, never another assignment; completed claims return null. Uploads use a stable `batchId`, retained across batching retries. Repeated identical batches are accepted without additional messages, usage, or SSE; reusing a key for different events returns 409. Completion is idempotent for an identical payload, including after a lost response.

Heartbeats report each owned turn, refreshing a per-turn lease. A missing machine heartbeat or a claimed turn omitted from heartbeats for 30 seconds fails that turn and emits a terminal event; merge failures return to Review. This recovers lost claim responses and daemon crashes even if the machine remains online. Expiry is checked before reviving a stale heartbeat and runs every five seconds in the server entry point, plus claim, heartbeat, and machine listing.

Session state is resolved at claim time from the immediate preceding terminal turn only. A missing state or changed agent/runtime/model forces a new session. Plan revisions explicitly receive read-only plan instructions.

`TurnJob`:

```ts
{
  turnId: string;
  buildId: string;
  todoId: string | null; // null for Chief
  topicId: string | null; // explicit Chief conversation ID, null for todo work
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

`TurnCompletePayload = {status:"done"|"failed"|"stopped", headCommit?, baseCommit?, diff?, plan?, usage?:{tokensIn,tokensOut,durationMs}, error?, sessionState?, merge?:{ok,error?}}`. `plan` creates the next plan document version; a supplied `diff` (including an empty string) creates the next changes document version. Usage is accumulated exactly once on the build, with an immutable per-turn breakdown. `baseCommit` is recorded on the first completion that supplies it. Runtime state is used by later turns and also copied to the topic for Chief.

## SSE

`GET /api/events` returns `text/event-stream`. It begins with a `connected` comment, sends 15-second ping comments, and emits each event as:

```ts
{ id: string; type: string; todoId?: string; conversationId?: string;
  turnId?: string; messageId?: string; message?: Message; payload: unknown }
```

`id:` is a persistent monotonic SQLite cursor in each SSE frame. Reconnects use `Last-Event-ID`; events after that cursor replay in order, including across server restarts. Entity event types are `project.changed|deleted`, `agent.changed|deleted`, `machine.changed|deleted`, `todo.created|changed`, `topic.changed|deleted`, `document.created`, `message.created|updated|deleted`, `message.queued|queue_changed|delivered`, `turn.queued|started|completed|stop_requested`. Every ingested `AgentEvent.type` is also broadcast unchanged (`message.delta`, `tool.started`, and so on), with its original event in `payload`. Message deltas/completions additionally carry stable `turnId`, `messageId`, and the complete updated `message` with `meta.revision`. The web upserts by ID and revision instead of concatenating replayed deltas, and merges history fetches against buffered revisions.

## MCP

`/mcp` uses the MCP SDK's stateful Streamable HTTP transport with JSON responses. It requires a per-turn Bearer token from `TurnJob.mcp.token`; tokens are accepted only while their turn is running, not stopping, and both machine heartbeat and turn lease are current. Machine tokens cannot authenticate MCP. Transport sessions are scoped to the turn token, so another turn cannot reuse the session ID. Clients must retain the `mcp-session-id` returned by `initialize` and send it on subsequent requests, along with the negotiated `mcp-protocol-version` header.

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

## Runtime integration and remaining limits

Codex uses `codex app-server` with fresh per-thread `config.mcp_servers.muster.{url,required:true,http_headers:{Authorization}}` on both start and resume. Required MCP initialization fails the thread if the board is unavailable. Plan turns use the `read-only` sandbox, writable turns use `danger-full-access`, and approvals are disabled. The local Codex 0.162.1 generated protocol and [official App Server documentation](https://learn.chatgpt.com/docs/app-server) establish the start/resume configuration and required-server behavior; HTTP headers follow the [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

Claude uses `--mcp-config` with `{mcpServers:{muster:{type:"http",url,headers:{Authorization}}}}` on each process, plus stream-json input/output and partial messages. `--system-prompt-snapshot off` ensures a resumed plan turn receives the new build instructions. Plan turns use permission mode `plan`; writable turns use `bypassPermissions`. Optional reasoning is passed as `--effort`. CLI flags were checked against local Claude Code 2.1.310. Protocol-peer tests assert the actual URL and bearer header for both adapters without calling a real model API.

Mock Chief messages beginning `/split` use the real MCP SDK client to list projects/agents, create two independent run-now todos using the first project and first non-Chief mock agent, and start them. MCP derives the topic association from the Chief token when `topicId` is omitted. Tool calls/results are persisted as normal tool messages. Other mock Chief prompts produce a deterministic reply. Coding mock turns append to `MUSTER_MOCK.md` in their isolated worktree.

Steer delivery is at least once across a daemon crash between runtime acceptance and ACK. Within a running daemon, a lost ACK retries without steering twice. Durable exactly-once model injection would require adapter-level message IDs. Builds cannot migrate live worktrees/sessions between machines; use restart if the assigned machine is unavailable. Machine enrollment itself has no retry key, and is not retried on ambiguous failures. SSE/idempotency journals currently have no retention pruning. Live paid model runs are outside automated tests; only local protocol inspection and model-free peers are exercised.
