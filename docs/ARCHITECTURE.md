# Muster architecture and contracts (M6)

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

On first start, Muster creates a `Chief` agent (`codex`, `default`, reasoning `medium`; shared `CHIEF_MODEL`) and a `General` topic. `chief.autoFollowUp` is represented by the `createApp({autoFollowUp})` server option and defaults to true; a persistent auto-follow-up control is not exposed. Shared `DEFAULT_MODELS` (derived from the runtime catalog) is `default` for every CLI runtime — Muster passes no model and the CLI uses its own configured one — and `mock` for Mock; the web agent editor uses the same defaults. Existing explicitly configured agents are preserved.

Migration 2 adds per-turn immutable agent/model snapshots, duration, heartbeat leases, and idempotent completion bodies. `event_batches` deduplicates uploads, `machine_claims` recovers claim responses, and `server_events` persists SSE replay. A later migration adds `server_events.created_at`: the log drops events older than 24 hours while always keeping the newest 5,000, and a client whose `Last-Event-ID` predates the retained window gets one `sync.reset` event telling the web app to refetch every query. Queued messages link to their source user message and record an in-flight delivery turn. `schema.sql` is a current-schema reference; `migrations.ts` is executed on startup.

## Local commands

- `npm install` installs all workspaces and prepares the daemon binary.
- `npm run dev` builds shared and starts server on 7420 plus Vite on 5173 concurrently. It stops both processes on interruption or a child failure. Watchers use polling by default; `CHOKIDAR_USEPOLLING=false` opts into native watching.
- `npm run daemon` builds shared and daemon, then starts against `http://127.0.0.1:7420`; extra flags such as `-- --concurrency 2` are forwarded. `MUSTER_HOME` controls the daemon's registration and workspaces; `MUSTER_DATA_DIR` controls server data.
- `npm run build && npm start` serves the built web app and API from 7420. Static paths resolve relative to the server module, independent of launch cwd.
- `npm run e2e` expects built packages. It starts a child server with an isolated `MUSTER_DATA_DIR` on an ephemeral port and a mock-only daemon. It verifies a real local Git merge, mid-turn steer delivery, concurrent isolated worktrees, Chief MCP delegation, production SPA routes, and SSE replay. All temporary data and processes are cleaned up.
- Vite proxies `/api` (including SSE) and `/mcp` to 7420. Remote daemons require a reachable `MUSTER_PUBLIC_URL`; set `HOST` explicitly to bind beyond loopback.

## REST API

The `{data: ...}` envelope described below applies to the web-facing `/api` routes, not the machine protocol, whose exact top-level responses are documented separately.

### Request security

Every route except `/health` passes one middleware that assumes the browser can be hostile. The `Host` hostname must be a loopback name (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), the hostname of `MUSTER_PUBLIC_URL`, or one listed in `MUSTER_ALLOWED_HOSTS`; anything else gets `403 {error: "Host not allowed"}`, which stops DNS-rebinding pages from reading responses or reaching any endpoint, including `/api/machine`, `/api/mcp`, `/mcp` and the static app. Unsafe methods (anything but `GET`, `HEAD` and `OPTIONS`) additionally require a same-origin `Origin`, when one is present, or the `MUSTER_PUBLIC_URL` origin, and reject `Sec-Fetch-Site: cross-site`; requests without an `Origin` header (curl, the daemon, MCP clients) are accepted, and the `Host` check still applies. Route bodies must declare `application/json` (`; charset=...` and `+json` suffixes are fine), so a `text/plain` POST from another page cannot be parsed as JSON and is answered `415 {error: "Expected application/json"}` before its handler runs. Multipart uploads are covered by the origin rule. Unmatched `/api` and `/mcp` paths answer `404 {error: "Not found"}` instead of the SPA document. The Vite proxy and the desktop window keep working because both keep a loopback `Host` and a matching `Origin`.

### Projects

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/projects` | `Project[]` |
| POST | `/api/projects` | `{name, repoUrl, baseBranch?}` → `Project` (201; branch defaults to `main`) |
| GET | `/api/projects/:id` | `Project` |
| PATCH | `/api/projects/:id` | any of `{name, repoUrl, baseBranch, description}` → `Project` |
| DELETE | `/api/projects/:id` | 204; returns 409 while referenced |

`Project = {id, name, repoUrl, baseBranch, description, createdAt}`.

### Agents

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/agents` | `Agent[]` (Chief first) |
| POST | `/api/agents` | `{name, role, runtime, model, reasoning?, avatar?}` → `Agent` (201) |
| GET | `/api/agents/:id` | `Agent` |
| PATCH | `/api/agents/:id` | any create field → `Agent` |
| DELETE | `/api/agents/:id` | 204; Chief cannot be deleted; referenced agents return 409 |

`runtime` is an id from the shared `RUNTIMES` catalog (`packages/shared/src/runtimes.ts`): `codex | claude | pi | omp | gemini | opencode | qwen | devin | cline | dsh | hermes | openclaw | kiro | auggie | qoder | droid | mock`. Migration 7 rebuilt `agents` without the old SQL `CHECK` list (with foreign keys off, then `foreign_key_check`), so validation lives in the shared zod schema. `Agent = {id, name, role, runtime, model, reasoning: string|null, avatar: string|null, isChief, createdAt}`.

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
| POST | `/api/todos` | `{projectId, title, spec?, agentId?, planAgentId?, mode?, tags?, createdBy?, topicId?}` → `Todo` (201); unknown project/agent/topic → 422 |
| GET | `/api/todos/:id` | `Todo & {builds: (Build & {turns: Turn[], documents: Document[]})[]}` |
| PATCH | `/api/todos/:id` | any of `{title, spec, agentId, planAgentId, tags}` → `Todo`; unknown agent → 422 |
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
- Inbox GET reserves delivery but does not consume the message. An explicit ACK removes it from the pending tray. On successful completion at Confirm or Review, all remaining feedback (including unacknowledged reservations) is atomically promoted, in order, into the opening prompt of one revise turn at that gate. The original user messages are linked to that turn without duplication, the queue clears, and `message.updated` / `message.queue_changed` events refresh the UI. Completion retries cannot enqueue duplicate revisions. Failed, stopped, or closed work releases reservations and retains pending feedback without automatically restarting it. Runtime-accepted feedback whose ACK is lost may be repeated in the revision, consistent with at-least-once delivery.
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

When a todo enters `confirm`, `review`, `failed`, or `done`, the server appends a system message to its associated topic or the oldest/default topic. With auto-follow-up enabled, a Chief-created todo also queues a Chief turn. Automatic follow-ups merge notices into the next queued Chief turn per topic instead of adding turns for each gate. An automatic turn becomes claimable after three seconds without new notices; migration 3 stores this deadline in `turns.not_before`, so pending batches survive restarts. A running Chief turn is never modified: new notices accumulate in at most one queued successor, which waits for that turn to finish. Notices can also join an existing user-requested turn without delaying it. Explicit user messages continue to request their own turns.

Automatic follow-up prompts identify the accumulated notices. Chief is instructed to inspect current todo states and report only changes since its last message, briefly; when nothing needs the user and nothing new is actionable, it uses one short line (or silence if supported by the runtime).

Todo `systemInstructions` contain only the agent role and platform conventions: isolated worktrees/branches, checkpoint ownership, MCP tools, asking the user (`ask_user` when available), and the Confirm/Review gates. They explicitly delegate phase permissions to the current turn's message, which overrides earlier phase instructions. They never contain phase-specific read-only or implementation rules, because runtime sessions can retain the first turn's developer/system instructions.

Every todo prompt starts with an explicit `PHASE: PLAN`, `PHASE: BUILD`, `PHASE: REVISE-AT-CONFIRM`, `PHASE: REVISE-AT-REVIEW`, or `PHASE: MERGE` instruction before the todo number/title/spec and feedback. Writable phase headers explicitly lift earlier planning restrictions. Accepted plan text remains in build prompts. Plan and Confirm-revise jobs have `readOnly:true`; build, Review-revise, and merge jobs are writable. Chief receives the PLAN §7 orchestration-only instruction.

A successful build or Review revision with `diff:""` still enters Review and stores the empty changes document. It also appends the system message `No file changes in this build` to the build conversation, linked to that turn and published through the normal `message.created` SSE event for UI visibility. Completion retries do not duplicate it. An omitted diff is unknown, not evidence of no changes.

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
- `{type:"warning", detail}`

Codex retryable `error` notifications (`willRetry:true`) and `warning` notifications emit `warning` events while the turn continues; non-retryable errors still fail the turn. The web keeps warnings separate from working status in a dismissible amber composer chip. Resumed message, reasoning, tool or plan output clears the warning for that turn, as does completion (done, failed or stopped). Usage and empty message-start deltas do not clear it. Warnings are transient activity, not persisted conversation messages; their SSE events retain the usual replay and batch deduplication behavior.

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

Codex uses `codex app-server` with fresh per-thread `config.mcp_servers.muster.{url,required:true,default_tools_approval_mode:"approve",http_headers:{Authorization}}` on both start and resume. Required MCP initialization fails the thread if the board is unavailable. Phase-agnostic `systemInstructions` are passed as `developerInstructions` on start/resume. Every `turn/start` explicitly sets `approvalPolicy:"never"` and `sandboxPolicy`: `{type:"readOnly",networkAccess:false}` for plan/Confirm revisions, `{type:"dangerFullAccess"}` otherwise. Start/resume also set the corresponding `sandbox` string (`read-only` or `danger-full-access`). Thus a resumed thread receives the current sandbox instead of relying on inherited defaults.

Protocol facts checked locally with `codex-cli 0.162.1`, using `codex app-server generate-ts --out <temporary-dir>` (and a separate `--experimental` generation):

- `v2/ThreadStartParams.ts` and `v2/ThreadResumeParams.ts` accept `developerInstructions`, `approvalPolicy`, and the string `sandbox` mode. Accepting resume configuration does not establish that it replaces earlier instructions already present in model history; phase rules therefore live in each turn's prompt.
- Stable `v2/TurnStartParams.ts` has no direct `developerInstructions` field. It accepts `approvalPolicy` and `sandboxPolicy`, documented as overrides for this turn and subsequent turns. Muster sends them every turn so transitions in either direction are explicit.
- This generated `v2/SandboxPolicy.ts` uses camelCase discriminants: `readOnly` requires the boolean `networkAccess`; `dangerFullAccess` has no extra fields. These differ from the hyphenated thread-level sandbox strings.
- Experimental `turn/start.collaborationMode.settings.developer_instructions` exists and takes precedence over model/effort/developer instructions. Muster does not depend on this experimental mode or raw history injection.

The [official App Server turn documentation](https://learn.chatgpt.com/docs/app-server#turns) confirms per-turn sandbox overrides and their persistence into subsequent turns. Generated types from the installed CLI determine the exact wire shape (newer online docs can differ). HTTP headers follow the [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

MCP tool approval is separate from filesystem sandboxing. Under `approvalPolicy:"never"`, a tool that needs approval is rejected, not implicitly approved. This caused real plan turns to fail Muster context lookups: the tools had no read-only annotations. Muster now auto-approves only its own authenticated platform server using `mcp_servers.muster.default_tools_approval_mode:"approve"`. This covers every turn kind, including state-changing platform tools, without changing plan turns' filesystem or network sandbox, other MCP servers' approval defaults, or the server's per-turn token checks. No global approval/reviewer setting is relaxed.

Approval findings checked with `codex-cli 0.162.1`:

- Generated `ThreadStartParams` and `ThreadResumeParams` accept the JSON `config` override; `TurnStartParams` has no MCP config field. The daemon therefore supplies the Muster server policy on every start/resume and retains explicit sandbox/approval overrides on every turn.
- Generated TS `v2/AppToolApproval.ts` and JSON Schema `v2/ConfigReadResponse.json` enumerate `auto|prompt|writes|approve`. The [official config schema](https://developers.openai.com/codex/config-schema.json), `RawMcpServerConfig`, places `default_tools_approval_mode` under each MCP server and per-tool overrides under `tools.<name>.approval_mode`. The installed parser independently confirms these values: `codex -c 'mcp_servers.muster={url="http://127.0.0.1:1/mcp",default_tools_approval_mode="invalid"}' debug prompt-input` rejects the value and lists the four accepted modes before executing anything.
- A local Responses fixture drove synthetic tool calls through the installed app-server and a local MCP fixture, with no real model API calls. With a read-only thread/turn and `approvalPolicy:"never"`, the results were:

  | Server approval mode | Unannotated tool | Tool with `annotations:{readOnlyHint:true}` |
  |---|---|---|
  | omitted / `auto` | rejected: `MCP tool call requires approval, but approval policy is never` | executes |
  | `writes` | rejected with the same error | executes |
  | `prompt` | rejected with the same error | rejected with the same error |
  | `approve` | executes | executes |

  This is a model-free approval-path check, not a live `gpt-6.1-sol` acceptance run. The thread response retained `{type:"readOnly",networkAccess:false}` with `approve`. Direct client `mcpServer/tool/call` requests do not exercise the model's approval gate and cannot establish this behavior by themselves.
- `enabled_tools` is a tool-catalog allowlist, not approval. `writes` plus read-only annotations would still reject platform mutations. Generated `AskForApproval` granular settings control categories of approval requests (including MCP elicitation), not server-specific automatic tool approval. A server-local `approve` default is the narrowest setting covering all Muster platform tools; per-tool overrides remain available for exceptions. See the [official MCP options](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options).

The server advertises `annotations:{readOnlyHint:true}` only on `list_projects`, `list_agents`, `list_todos`, and `get_todo`. Mutating tools are not marked read-only. The annotation is honored by Codex's default/`writes` approval paths, but is not a substitute for the explicit Muster server policy. Model-free daemon protocol-peer tests assert that policy is scoped to Muster on both new/resumed threads for plan, build, both revision gates, merge, and Chief; they also assert the unchanged thread/turn sandbox and `never` policy. The server catalog test verifies the read-only annotations over MCP.

Claude uses `--mcp-config` with `{mcpServers:{muster:{type:"http",url,headers:{Authorization}}}}` on each process, plus stream-json input/output and partial messages. `--append-system-prompt` receives the same phase-agnostic instructions across a todo's turns, and the current phase rules arrive in each user message, avoiding the same stale-instruction hazard with `--resume`. `--system-prompt-snapshot off` remains enabled. Plan turns use permission mode `plan`; writable turns use `bypassPermissions`. Optional reasoning is passed as `--effort`. CLI flags were checked against local Claude Code 2.1.310. Protocol-peer tests assert the actual URL and bearer header for both adapters and the Codex turn sandbox policies on new/resumed threads without calling a real model API.

pi and omp use `pi --mode rpc`: JSONL commands (`prompt`, `steer`, `abort`, `get_state`, `extension_ui_response`) and events (`message_update` text/thinking deltas, `message_end` with per-call usage, `tool_execution_start/end`, `agent_end`). A turn ends after `agent_end` once `get_state` reports the session file, which is stored as `sessionState.sessionFile` and resumed with `--session` if it still exists. Extension dialogs are cancelled because nobody is at the machine. Every turn writes a private temporary bridge directory (0700; config 0600, removed when the turn ends) holding a dependency-free MCP Streamable HTTP/stdio client, a pi extension that registers each MCP tool via `pi.registerTool` (plain JSON Schema parameters, which pi-ai validates) and, on plan turns, calls `setActiveTools` with the read-only built-ins plus those tools.

ACP runtimes (including `qodercli --acp` and `droid exec --output-format acp`) run `initialize` (protocol 1, no client fs/terminal), then `session/resume` / `session/load` (history replay suppressed) or `session/new` with Muster's MCP endpoint and granted connections. HTTP servers are passed only when `mcpCapabilities.http` is advertised; otherwise each one becomes a stdio server running the bridge's proxy under the daemon's Node (`ELECTRON_RUN_AS_NODE=1` for the desktop bundle). A model other than `default` is set with a `model` config option, else `session/set_model` (an agent that lists models rejects unknown ids up front); reasoning maps to a `thought_level` option when offered. `session/request_permission` picks `allow_always`/`allow_once`, or `reject_once` for write kinds on plan turns; other agent→client requests return `-32601`. `session/update` maps message/thought chunks, `tool_call(_update)` and `plan`; text before a tool call is completed as its own message and the last one becomes the plan text. Steering is queued and sent as the next `session/prompt` of the same turn; interrupt sends `session/cancel`. `sessionState` keeps `sessionId` and a hash of the instructions that led the session's first prompt.

The turn MCP endpoint (`/mcp`) keeps one Streamable HTTP session per `initialize` under a turn token (at most 8, oldest dropped), because ACP agents such as Hermes restart their MCP servers within a turn; requests route by `mcp-session-id`, and an unknown or another turn's session id gets 404.

`JsonProcess` frames stdout on LF only (Node `readline` also splits on U+2028/U+2029, which are legal inside JSON strings); pi and ACP processes keep non-JSON stdout lines as diagnostics instead of failing. The daemon resolves each runtime to an absolute executable (`locateRuntimes`), re-enrolling when the detected set changes.

Mock Chief messages beginning `/split` use the real MCP SDK client to list projects/agents, create two independent run-now todos using the first project and first non-Chief mock agent, and start them. MCP derives the topic association from the Chief token when `topicId` is omitted. Tool calls/results are persisted as normal tool messages. Other mock Chief prompts produce a deterministic reply. Coding mock turns append to `MUSTER_MOCK.md` in their isolated worktree.

Steer delivery is at least once across a daemon crash between runtime acceptance and ACK. Within a running daemon, a lost ACK retries without steering twice. Durable exactly-once model injection would require adapter-level message IDs. Builds cannot migrate live worktrees/sessions between machines; use restart if the assigned machine is unavailable. Machine enrollment itself has no retry key, and is not retried on ambiguous failures. SSE/idempotency journals currently have no retention pruning. Live paid model runs are outside automated tests; only local protocol inspection and model-free peers are exercised.

## Desktop (M6)

`apps/desktop` is an Electron + strict TypeScript workspace. The main process discovers a local server starting at 7420, recognizes Muster using `/health` (with a compatibility check of `/api/topics` for older servers), attaches when possible, and skips ports occupied by unrelated services. An owned server binds only to loopback and serves the bundled web dist. Both server data and daemon home default to `~/.muster`; `MUSTER_DATA_DIR` overrides the desktop's whole data directory. The daemon automatically enrolls with the selected origin. A matching already-running CLI daemon is reused, while a daemon connected to another server produces an actionable startup error.

Workers use `child_process.fork` with `execPath: process.execPath`, `execArgv: []`, and `ELECTRON_RUN_AS_NODE=1`. No system Node is needed. **Verified on macOS arm64 with Electron 45.0.0: bundled Node 24.22.0 imports `node:sqlite`, opens an in-memory database, and returns SQLite 3.53.4 without `--experimental-sqlite` or native addons.** The server and daemon retain their existing entrypoints and dependencies. The small worker entry bridge preserves main-module detection and supports cooperative SIGTERM semantics through IPC on Windows, where native `kill(SIGTERM)` would terminate immediately. See Electron's [run-as-Node documentation](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node) and [process model](https://www.electronjs.org/docs/latest/tutorial/process-model).

On quit, the app sends SIGTERM to its daemon, aborts pending claim/heartbeat/inbox requests and polling sleeps, interrupts running turns and lets them report `stopped` before stopping its server. Idle shutdown does not wait for the 25-second claim poll. The server rolls back claims if the connection closes before the response finishes, including the turn assignment, MCP token and initial build affinity. Each owned worker has a 10-second grace period before SIGKILL; if reporting cannot finish, the daemon journal remains available for recovery on restart. Attached servers/daemons are never stopped. SIGINT/SIGTERM to the desktop also use this cleanup path. Single-instance locking prevents two desktop claim loops.

The daemon receives a PATH resolved through the user's `$SHELL -ilc` login shell (bounded to five seconds, with marked output to discard startup chatter). It retains inherited absolute PATH entries and appends `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin` and standard Unix system directories. Windows retains its native PATH. User CLIs and Git still need to be installed/authenticated separately.

The BrowserWindow loads only the local origin, disables renderer Node integration, enables context isolation and sandboxing, starts against a dark background, and remembers visible window bounds. A bundled CommonJS preload exposes only `window.muster.desktop`, platform, a native folder picker, opening absolute paths, and subscriptions to menu/notification commands. Main-process IPC handlers verify the sending window, frame and origin. HTTP(S) links open externally; other external schemes are denied. macOS traffic-light padding and drag regions are scoped to desktop-only CSS classes. The browser UI retains its normal layout.

The main process watches replayable SSE for Confirm/Review/Failed notifications, and polls status for the Needs-you dock badge and machine/running tray status. Notification clicks focus the todo through the preload command subscription. Standard native menus include New task (CmdOrCtrl+N), Open in browser and Show logs. Logs are `<data dir>/logs/{desktop,server,daemon}.log`; the daemon also keeps its usual `daemon.log` at its home.

`npm run desktop:dev` and the distribution script check the Electron executable and run `node node_modules/electron/install.js` if it is missing (including installs that skipped lifecycle scripts). Download failures report the installer command and network/proxy troubleshooting context.

`npm run desktop:dist` first builds every workspace, stages the server/daemon/shared dist files with production dependencies and built web assets outside ASAR, and packages with electron-builder. npm workspace links are materialized into actual bundled directories, so the application has no checkout dependency. The `beforeBuild` hook returns false to mark these dependencies as externally handled: unlike `npmRebuild: false`, this also skips redundant dependency collection for main/preload, which have no npm runtime dependencies. This is needed on hosts where `npm prefix -w` returns an invalid workspace root; it does not change the staged runtime dependencies. The Electron main/preload code is in ASAR. The icon generator rasterizes the existing Command mark into PNG/ICNS/ICO using Node alone. macOS uses explicit ad-hoc signing (`identity: "-"`) and emits an app plus DMG for the host architecture; no developer identity, notarization or installation is involved. On hosts where DiskImages cannot allocate virtual devices, the packager falls back to `hdiutil makehybrid -hfs`, creating a valid, uncompressed HFS distribution DMG without mounting; it includes the signed app and an Applications shortcut. Windows NSIS and Linux AppImage targets remain configured; their native packaging is not verified by a macOS build.

macOS packaged startup validates the real bundle path before creating the Muster data directory, acquiring the application lock or starting workers. Only `/Applications` and `~/Applications` installations are accepted; symlinks to release copies do not qualify. Other locations offer localized Move to Applications / Quit actions. Moving is permitted only when neither Applications destination exists, and Electron's conflict handler rejects replacement even if a destination appears during the move. Cancellation/failure never starts services. Existing installations must be updated manually. Development and non-macOS launches retain their existing behavior.

The distribution script checks process executable paths and bundle identities before staging or packaging. A `dev.muster.desktop` process inside this checkout's real release directory blocks packaging with its PID/path; inspection errors also fail the command. It neither stops processes nor changes the fixed output layout. This check is not atomic: do not start old release copies during a build. Both normal and fallback DMG success paths unregister only the generated release bundle with `lsregister -u`. Unregistration is idempotent: `kLSApplicationNotFoundErr` (`-10814`) from a never-registered bundle is success. Other command failures are warnings and do not fail an otherwise completed package; installation-path validation remains the primary defense. The release-boundary check still rejects paths outside release. Unregistration cannot stop an existing instance or permanently prevent registration. Single-instance locking and `open` do not establish the installed path; startup logs include executable, resources and bundle paths.

The smoke harness changes only its temporary macOS copy to `dev.muster.desktop.smoke`, re-signs it ad hoc, and verifies its identity before launch. Only that identity together with smoke arguments and a separate absolute data directory bypasses installation validation. Readiness evidence includes executable/resources paths and bundle identity, which the harness asserts against its copy. The production bundle cannot bypass installation checks using only `--smoke-test`. Worker-only verification retains the packaged Node bridge flow.

`npm run desktop:smoke` runs the packaged app with a hidden window and an isolated temporary data directory. It checks the rendered sidebar and preload, real SQLite server startup, automatic enrollment, a mock Chief turn interrupted by SIGTERM and persisted as `stopped`, then attachment to an externally running server that survives desktop quit. It saves a screenshot and logs in the printed temporary evidence directory. Tests never call real model APIs. The underlying `--smoke-test` flag keeps the window hidden, disables native notifications, and exits after startup verification; `--smoke-hold` allows the harness to exercise graceful shutdown. `MUSTER_DESKTOP_PORT` overrides the starting discovery port for isolated smoke runs.

On this restricted build host, native application registration aborts Electron in macOS LaunchServices before JavaScript starts, so GUI smoke validation remains unverified here. `npm run desktop:smoke -- --workers-only` independently verifies the packaged ASAR worker entry bridge, real production dependencies, automatic enrollment, bundled SQLite and persisted SIGTERM completion. It does not claim to verify the native window. The full default smoke command remains available on a normal macOS desktop session.

## Internationalization

Web copy lives in `apps/web/src/i18n`: the nested English dictionary defines `MessageKey` and the recursive `Messages` shape, enforced for Simplified Chinese (`zh-CN`). `I18nProvider` selects a validated `muster.locale` preference or detects Chinese from any `zh*` entry in `navigator.languages` (otherwise English), updates the HTML language/title and exposes `useI18n()`. Unsupported stored preferences fall back to detection. Language and appearance remain per-device preferences in that cache; the server stores the workspace name and notification preferences, which the desktop reads. Dictionary modules and native picker names are discovered from the shared locale list. `t(key, params)` interpolates named values and selects `{one, other}` forms with `Intl.PluralRules`; date, relative time, number and duration helpers use the active locale. Phase, runtime and status labels have centralized dictionaries. Tests verify nonempty copy, placeholder parity and live language switching. Components rendered without a provider default to English, keeping isolated tests deterministic.

System messages with `meta.todoId` and a known `meta.phase` render a translated notice. New notices include `todoNumber` and `todoTitle`; legacy structured notices retain their original task identity. Stored English content and Chief prompts remain unchanged; unstructured history, user/agent text, tools, unknown runtime diagnostics and unknown errors retain their source content. Known API error messages are mapped at render time, so switching languages also updates visible errors.

The desktop has its own small dictionary in `apps/desktop/src/i18n.ts`; only locale codes and matching logic are shared through `@muster/shared`. Before the renderer reports, main uses `app.getPreferredSystemLanguages()`. The preload's `setLocale` invokes a validated IPC handler restricted to the trusted main frame and local origin; main then rebuilds menus and tray status immediately. Notifications use translated human phase names and retain the user's task title. Standard Electron menu roles remain native and follow the OS language.

## Phase A: agent resources

Migration 4 is forward-only from v3. `agents.role` remains the duty text (there is no description column); new columns are `permissions_json`, `default_skill_ids_json`, and `updated_at`. Permissions normalize to four booleans: `pushBranch`, `secrets`, `createSkills`, `updateSkills`, all false except Chief's initial create/update skills permissions. Existing duties and configuration survive migration. New tables:

- `agent_memories(id, agent_id, content, source, created_at, updated_at)`, cascading on agent deletion; `source` is `user|agent`.
- `skills(id, slug UNIQUE, name, description, source_json, created_at, updated_at)`; files live under the server data directory's `skills/<slug>/`.
- `secrets(id, scope, project_id, name, ciphertext, iv, tag, created_at, updated_at)`. Scope/project consistency is checked. A partial unique index enforces team-name uniqueness despite SQLite's nullable composite-unique behavior.

`createApp` accepts `dataDir` and an injectable `githubFetcher`. A file-backed database defaults resources to its parent directory; in-memory applications get isolated temporary directories. The normal server and desktop consequently use their existing data directory. Resource content is never written to global Codex/Claude configuration directories.

### HTTP and MCP

All UI routes use the usual `{data}` envelope:

| Method | Route | Result / behavior |
| --- | --- | --- |
| GET/PATCH | `/api/agents/:id` | Shared Zod validation; GET includes `inProgress`, `memoryCount`, `skillCount` in the same response. PATCH validates referenced skill IDs. Runtime/model changes retain the existing session-reset comparison on the next claim. |
| DELETE | `/api/agents/:id` | Chief and agents with queued/running work return 409. Otherwise clears todo assignments, preserves immutable historical snapshots and removes memories. |
| GET/POST | `/api/agents/:id/memories` | Newest-first list / create with source `user`. |
| PATCH/DELETE | `/api/agents/:id/memories/:memoryId` | Both IDs must match; content is trimmed and bounded. |
| GET | `/api/skills` | Library metadata, including a SHA-256 content version. |
| POST | `/api/skills/upload` | Multipart `files` retaining relative filenames, optional `bulk=true`; `?preview=true` returns editable metadata and copied file data. |
| POST | `/api/skills/github` | `{url}` for a public GitHub repository or `/tree/<ref>/<path>`; supports the same preview query. |
| POST | `/api/skills/import` | Saves reviewed names/descriptions and copied files; preflights conflicts and rolls back newly created skills on an import failure. |
| GET/DELETE | `/api/skills/:slug` | Renderable SKILL.md, file list, source and default agents / delete and remove defaults. |
| GET | `/api/machine/skills/:slug/archive?version=<hash>` | Machine bearer auth, JSON `{files:[{path,content}]}` with base64 content. A changed version returns 409 instead of delivering different content. |
| GET | `/api/secrets?projectId=` | Metadata only; omitted filter lists all scopes, a project filter includes that project and team values. |
| PUT | `/api/secrets` | `{scope,projectId?,name,value,requestId?}`; create/replace; response is metadata only. |
| DELETE | `/api/secrets/:id` | Deletes the encrypted value. |

MCP adds `list_memories` (read-only), `remember {content}`, `forget {memoryId}`, `list_skills` (read-only), `install_skill_from_github {url}`, `create_skill {name,description,instructions}`, `update_skill {slug,description?,instructions?}`, and `request_secret {name,scope,projectId?,reason}`. Memory ownership comes from the authenticated running turn's immutable agent snapshot, never from caller input. Skill creation/install and updates check the agent's current permissions on every call; unauthorized calls return MCP tool errors. `create_agent` cannot grant elevated permissions. Chief alone can request secure input; the tool returns `requested` immediately and instructs Chief to wait for the user.

A secret request is a system message with `meta.secretRequest`. Its card calls PUT directly; the server validates request ID, name and scope before saving, then sets `meta.fulfilledAt`. The value never enters messages or SSE. Saving does not automatically enqueue another Chief turn; the user can continue the conversation after saving.

### Delivery and runtime behavior

`TurnJob` adds `skills: {slug,name,description,version}[]`, optional `env: Record<string,string>`, and `pushBranch`. At claim time the server unions agent defaults with exact `@skill-slug` mentions in the todo spec and conversation messages; Chief receives its defaults. Current memories are appended under `## Memory`, newest first, with a roughly 4k-character cap and truncation marker. Skill changes and newly installed skills take effect on subsequent claims, not by hot-loading an active runtime.

The daemon downloads a skill once per hash into `<MUSTER_HOME>/skills-cache/<slug>@<hash>/`, verifies paths, size and hash, writes files through a temporary directory, and appends an `## Available skills` index with absolute SKILL.md paths and the read-before-use rule. Cache files are outside the worktree. Read-only turns additionally inline the SKILL.md body as a conservative fallback; supporting files remain in the cache. Cache versions are not pruned automatically. Archives currently serve the current library version; edits/deletes between claim and download fail explicitly and require retry.

Secrets use AES-256-GCM, a fresh 12-byte IV and authenticated scope/project/name binding. `<data>/secret.key` is generated with exclusive creation and mode 0600, and must be backed up together with the database. Names follow `^[A-Z_][A-Z0-9_]{0,63}$`; PATH, HOME, MUSTER_*, CODEX_*, CLAUDE_*, ELECTRON_*, NODE_OPTIONS and NODE_ENV are reserved. Authorized agents receive team plus project secrets, with project overrides, **including plan turns**. Existing plan network restrictions still apply. The machine claim journal serializes the job before adding `env`; a replay rechecks current permission and decrypts current values. No secret value is persisted in `machine_claims.job_json`.

Both CLI processes receive the granted environment. Codex also gets `config.shell_environment_policy.set` on every thread start/resume, explicitly empty when no grants exist. This selects granted variables without disabling the default filter for unrelated inherited credentials. Claude's child Bash inherits the process environment. The daemon redacts literal granted values of at least six characters throughout event payloads and completion payloads (messages, tool data, errors, plans, diffs and session metadata). Message/reasoning deltas keep streaming when secrets are granted: the daemon redacts the accumulated text and holds back only the trailing (longest secret − 1) characters, so a value split across chunks is always replaced before any part of it is uploaded; the held tail is flushed with the completed message. This is literal replacement, not detection of encoded/transformed secrets. It cannot scrub files committed by a runtime, CLI-local histories, external service logs, or unrelated machine credentials. Self-hosted runtimes execute as the daemon's OS user; these grants are delivery controls, not isolation from that user's existing credentials or the loopback API.

When `pushBranch` is true, a successful writable runtime result is checkpointed and the task branch is pushed to the repository origin. Failed/stopped/plan turns never trigger this automatic push. This permission does not change the existing user-authorized merge-to-base flow, nor prevent a full-access runtime from invoking git itself.

### Verified facts and limits

Checked on the installed **codex-cli 0.162.1** with `app-server generate-ts` and `generate-json-schema`: `ThreadStartParams` and `ThreadResumeParams` accept a JSON `config`; `SandboxPolicy` has `readOnly {networkAccess:boolean}` and no additional read-root field. The [official config schema](https://developers.openai.com/codex/config-schema.json) defines `ShellEnvironmentPolicyToml.set` as a string map, and the [advanced configuration guide](https://learn.chatgpt.com/docs/config-file/config-advanced) describes the shell environment policy. Model-free protocol peers assert the actual adapter payload on new/resumed threads and the subprocess environment; a Claude peer launches a real `/bin/sh` child to verify inheritance. No paid model API is called.

**Host limitation:** starting the installed Codex sandbox is rejected here with `sandbox-exec: sandbox_apply: Operation not permitted`. A direct installed app-server configuration-read attempt also fails because this task cannot initialize SQLite state under `~/.codex`. Therefore actual 0.162.1 sandbox reads outside a worktree and real model-issued shell environment propagation are not claimed as verified. Plan SKILL.md inlining avoids depending on those reads; optional supporting-file access still needs validation on an unrestricted daemon host. Protocol-peer checks and generated types establish our wire contract, not full CLI execution acceptance.

Skill imports reject absolute/traversing/backslash paths, duplicates, symlinks on server-read folders, non-regular files, more than 200 files and more than 5 MB. Multipart and reviewed imports also bound the entire upload (bulk shares this bound). Browser/desktop directory uploads contain only file bytes and relative paths; they cannot expose the original filesystem's symlink metadata. GitHub imports inspect the fetched filesystem, reject symlinks and use a temporary shallow sparse clone with disabled prompts/hooks; public access requires git/network access. Ref names containing `/` are ambiguous in GitHub tree URLs and are not supported; use a slash-free branch/tag. The clone itself can consume network/disk before the post-checkout 5 MB validation. Windows/macOS/Linux share the JSON archive format, but this change's tests run on this macOS host.

UI routes are `/agents/:id` (Overview/Memory), `/skills`, `/skills/new`, `/skills/:slug`, and `/secrets`. Both renderer hosts use directory uploads; there is no new native IPC surface. Agent cards link to profiles; creation navigates to the new profile. Keyboard-navigable mentions are shared by Chief, todo and new-task composers; new-task agent mentions set an unselected assignee. All added copy and known API errors have English and Simplified Chinese translations. Visual review remains manual; no headless Chromium or desktop distribution build is used.

## Phase B: schedules and connections

Migration 5 adds `schedules`, `connections`, `agents.connection_ids_json` and build-level
`required_machine_id` / `scheduled_agent_id`. Schedule references survive restarts;
foreign keys prevent deleting machines or agents still referenced by schedules/builds.
Connection deletion removes agent grants in the same transaction. Identifiers are
immutable, unique, match `^[a-z][a-z0-9_]{1,31}$`, and cannot be `muster`.

### Schedules

`nextRun(schedule, after)` in shared is pure, uses Intl/IANA wall-clock conversion,
and returns the first occurrence strictly after `after`. Repeated DST times select
only the first occurrence; missing times advance to the first valid minute. Hourly,
daily and weekly rules use the saved zone; once uses an absolute UTC instant.
Creating/updating a past once disables it. Browser creation captures its local zone;
editing recurring rules preserves the saved zone. The once date input uses browser
local time and converts to UTC.

The server entry point runs a startup tick and an unref'ed 30-second interval, stopped
on shutdown. Embedded `createApp` callers can invoke `services.schedules.tick()`;
it deliberately does not start background timers. Each due schedule is rechecked
inside an immediate SQLite transaction, advances to a future occurrence first, and
starts at most one run. Busy phases or any queued/running turn produce `skipped_busy`.
Other phases get a new branch/build with no session, old plan, or old conversation
prompt. The task title/spec and selected mode determine the new prompt. The schedule's
agent override is build-scoped, leaving task assignments intact. A machine requirement
is separate from claimed worktree affinity and survives a released claim. Normal
Confirm/Review gates remain in force. A system message carries `{scheduleId}` and SSE
updates the conversation and schedules page. Once disables after an attempted firing,
including run-now or busy skips. Run-now advances the cadence too; disabled recurring
schedules stay disabled. Errors retain a generic diagnostic and the next occurrence.
No missed-run queue is replayed.

REST: GET/POST `/api/schedules`, optional GET `?todoId=`, GET/PATCH/DELETE
`/api/schedules/:id`, POST `/api/schedules/:id/run`. Shared Zod validates full creates
and merged patches. Chief MCP adds read-only `list_schedules`, `create_schedule`, and
`delete_schedule`; mutating schedule tools and schedule listing require Chief identity.
The `/schedules` page uses existing settings components; the task header's Repeat
button opens the same editor. Enabled schedules appear as task chips.

### Connections and credentials

REST: GET/POST `/api/connections`, GET/PATCH/DELETE `/api/connections/:id`, POST
`/api/connections/:id/test`. Metadata exposes credential **keys**, never values. A
missing `secrets` patch preserves credentials; an explicit object replaces the entire
map, with `{}` clearing it. AES-256-GCM uses Phase A's `secret.key` and a fresh IV,
with connection ID and immutable identifier as authenticated binding. Back up that
key and the database together. HTTP credentials are headers; stdio credentials are
environment values. HTTP cannot be machine pinned. The UI requires an online machine
for new stdio connections; the API also allows null to run on any claiming machine.
Existing offline pins remain editable.

Agents grant connections through their profile. Chief can `list_connections` (read-only,
no credentials), `grant_connection`, and `revoke_connection`. Only Chief can mutate
these grants through MCP. Claim and replay re-derive current grants and decrypt values
into `TurnJob.connections` **after** writing the claim journal. Stdio pinned elsewhere
is omitted and produces one system note per turn/connection name. Grant changes take
effect on subsequent claims/replays, not an already running process. Instructions list
each delivered `mcp__identifier__*` prefix.

HTTP testing uses the official MCP SDK Client/StreamableHTTPClientTransport,
initialize and paginated tools/list, with a shared 10-second abort deadline. Results
are `{ok,toolCount,tools,error}`; tool names are capped at 50. Errors are generic to
avoid reflecting credentials. Stdio tests never execute on the server: the UI says
it will be tested by the machine on its next run. This is a deferred runtime startup,
not a background machine test job.

Codex receives `mcp_servers.<identifier>` beside `muster`, with `url/http_headers` or
`command/args/env`. `default_tools_approval_mode: "approve"` honors the user's explicit
agent grant: with Muster's `approvalPolicy: "never"`, calls must not hang waiting for
an unavailable approval UI. This does **not** change plan turns' `read-only` thread
sandbox or `{type:"readOnly",networkAccess:false}` turn policy. Filesystem sandboxing
is not a read-only policy for external MCP services: a granted service may expose
write tools, and local MCP processes run as the daemon OS user. Use appropriately
scoped provider tokens. Claude receives matching entries in `--mcp-config`, retaining
`plan` versus `bypassPermissions` modes. Inherited machine CLI configuration and
credentials are not an isolation boundary.

Daemon upload redaction includes connection headers/env and bare Bearer tokens;
connection-bearing jobs redact nonempty short values too. Streaming splits, tool
payloads and completion objects share the same credential set. This is literal
replacement, not encoded-secret detection or scrubbing of runtime files/history.

### Catalog and verified runtime facts

The typed catalog has English/Chinese descriptions and capability bullets, local
monogram/color tiles, and these entries, checked against official sources during
Phase B (2026-10-25):

| Entry | Transport / authentication | Official source |
| --- | --- | --- |
| Linear | `https://mcp.linear.app/mcp`, Bearer API key | https://linear.app/docs/mcp |
| GitHub | `https://api.githubcopilot.com/mcp/`, Bearer PAT | https://github.com/github/github-mcp-server |
| Notion | `https://mcp.notion.com/mcp`, OAuth only in this catalog | https://developers.notion.com/guides/mcp/get-started-with-mcp |
| Playwright | stdio `npx -y @playwright/mcp@latest`, no token | https://github.com/microsoft/playwright-mcp |

OAuth sign-in is **not implemented**: the Notion dialog explains this and offers no
Connect action. No unverified provider endpoints are included. Custom HTTP/stdio
connections remain available; catalog package versions using `@latest` can change.

Verified locally: **codex-cli 0.162.1** `app-server generate-ts` accepts JSON config in
ThreadStart/ThreadResume. Its `mcp get --json` parser accepted the exact HTTP headers
and stdio command/args/env shapes using command-line overrides (no global config
writes). The official [MCP reference](https://learn.chatgpt.com/docs/extend/mcp) and
[configuration schema](https://developers.openai.com/codex/config-schema.json) describe
the approval setting. **Claude Code 2.1.310** `mcp add-json --scope project` accepted
both shapes in a temporary project with isolated CLI configuration; fixtures were
removed afterwards. Process protocol peers assert exact HTTP/stdio maps, resumed
Codex threads and unchanged plan sandboxes. These checks do not claim live provider
authentication or real model tool execution. Tests use local fixtures and mock turns.
Visual review remains manual; no screenshots or desktop distribution build is used.

## Phase C: settings, external MCP, projects and task input

Migration 6 adds `settings(key,value)` (JSON values), `api_keys`, project `description`,
and attachment metadata. GET/PATCH `/api/settings` exposes validated workspace name,
language (`en|zh-CN`), appearance (`light|dark|system`), and notifications. GET/PATCH
`/api/settings/notifications` exposes per-phase `confirm`, `review`, `failed`, `done`
and independent `dockBadge` booleans (all default on). The renderer keeps language
and appearance per device in `localStorage` and applies them globally; workspace
name and notifications are the settings it reads from the server. The desktop main
process reads notification preferences before a
notification and on status polling. A disabled Dock badge clears its count. Native
notifications include Done. Browser settings explain their desktop-only effect.

### Personal API keys and external MCP

GET/POST `/api/api-keys` lists metadata or creates a key; DELETE `/api/api-keys/:id`
revokes it. A cryptographically random key is `mst_` plus 32 uniformly sampled
base62 characters. SQLite stores SHA256, a ten-character display prefix, name,
scopes JSON, creation/last-use/revocation timestamps. Only the creation response
contains the full key; UI shows it once with a copy action. Metadata never returns
hashes. Both `read` and `chief` scopes enable MCP; there is no separate `mcp` scope.

`/api/mcp` uses the same SDK Streamable HTTP implementation as the per-turn MCP,
with stateless JSON responses. Every request authenticates `Authorization: Bearer
mst_…`, checks revocation and updates last use. It needs no transport session ID;
clients still initialize and negotiate the protocol normally. The per-turn `/mcp`
contract and catalog are unchanged. Failed authentication gets 401 for the first
20 attempts per server instance in a fixed 60-second window, then 429 with
`Retry-After`. Valid credentials remain usable during this window. This bounded
in-memory limiter resets on restart and does not trust forwarded IP headers.

External read tools (all annotated `readOnlyHint:true`): `list_projects`,
`get_project`, `list_agents`, `get_agent`, `list_todos`, `get_todo`, `list_topics`,
`get_topic`, `list_schedules`, `list_skills`. Chief keys additionally expose
`create_todo`, `start_todo`, `confirm_plan`, `complete_todo`, `close_todo`,
`send_todo_message`, `post_topic_message`, `create_schedule`. Posting a topic
message persists a user message and queues a Chief turn. Writes are absent from
both the read-only catalog and its execution registry. Existing orchestration
phase gates remain enforced. External clients do not inherit a live agent turn's
memory, secret-request or connection-grant capabilities.

Key management and other web REST routes retain Muster's trusted-local-workspace
model; API keys secure the external MCP route, not the whole REST API. Network
hosting still requires an authenticated reverse proxy and TLS.

The Settings MCP tab uses the current renderer origin. Verified locally on
2026-10-25: **Claude Code 2.1.310**, `claude mcp add --help`, documents
`--transport http`, positional name/URL and `--header`. **codex-cli 0.162.1**,
`codex mcp --help` / `add --help`, documents HTTP URL setup; `mcp get muster
--json` with isolated command-line overrides parsed `url` plus `http_headers`
as Streamable HTTP. No user CLI configuration was changed. Exact client snippets
are in README and generated by `clientSnippets()` for the Settings page. Cursor's
snippet is generic MCP JSON; no installed Cursor client was exercised.

### Read-only project browsing

`/projects/:id` has Files and Tasks; `/projects/:id/settings` edits name, base
branch and description. The repository identifier is displayed read-only with a
copy action; REST preserves its existing editing contract. Deleting a project
retains existing foreign-key semantics: referenced tasks (including running work)
prevent deletion. Cards and sidebar entries link to the project, with nested-route
highlighting. Task search/filter/sort and list/grid operate on the existing todo
query. Branch selection uses GET `/api/projects/:id/branches`, falling back to a
text field when local branches cannot be read.

GET `/api/projects/:id/tree?path=`, `/file?path=`, `/commits` and `/commits/:sha`
read an absolute local `repoUrl` accessible to the **server**. No clone, fetch,
checkout or working-tree read is performed. Base branch resolution is restricted
to `refs/heads/…`, then commands use its resolved commit ID. `ls-tree -z` returns
one directory at a time; the UI loads folders on demand. `cat-file` checks type
and size before reading a blob, never follows repository symlinks. Absolute,
parent-segment, backslash and NUL paths are rejected. History contains at most 100
commits; detail requires a full 40-character SHA reachable from the base branch,
and uses `git show --no-ext-diff --no-textconv`. Commands have an 8-second timeout
and 4 MB output cap; files have a 1 MB cap and NUL-containing blobs display a
binary notice. Oversized commit diffs produce an explicit error. Markdown uses
the existing safe renderer; other text has line numbers. Remote, relative and
inaccessible repository paths have a local-repository explanation. Uncommitted
working-tree edits are intentionally not displayed.

### Attachments and task creation

GET/POST `/api/todos/:id/attachments` lists/uploads files. Multipart requests are
bounded to 20 MB plus 64 KB framing overhead, and stored bytes to 20 MB / 10 files
per todo. Uploads are allowed only in Backlog. Server paths are
`<data>/attachments/<todoId>/<attachmentId>`; user filenames are metadata only.
Each item has `{id,todoId,name,size,hash}`. The machine claim response includes
current attachment metadata, including on replay. GET
`/api/machine/attachments/:id` requires the existing machine bearer credential
and returns a base64 payload. As with skill archives, enrolled machines are trusted
workspace participants, not per-task access principals.

The daemon verifies size and SHA256, caches immutable content once under absolute
`<MUSTER_HOME>/attachments-cache/<id>-<hash>`, and appends original names and
absolute paths to each task prompt. Cache files stay outside git worktrees and are
not auto-pruned. Deleting a todo via REST closes it and removes its server-side
attachments; Close alone preserves attachments for reopen. Deletion during a
pending download may cause that turn to fail explicitly. Read-only runtime access
to external cache paths remains subject to the installed CLI sandbox (see Phase A
host limitation); no real model read was tested.

The task dialog puts the project picker in its header, has a localized structured
placeholder, compact default-agent selection, tags (Enter/backspace), file input
and drop, mentions, Save and Save & start. Plan first is the initial default;
plan/run choice and sidebar group collapse state persist in browser storage for
the local user. Creation retains its todo ID after upload/start failure to avoid
creating another task on retry. Chief empty-state tiles open project creation,
link to skill import, or fill the composer. Topic menus preserve existing deletion
rules; board help explains the gates.

### Shortcuts and verification

`apps/web/src/lib/shortcuts.ts` is the typed source for event matching and Settings
/help display: ⌘K all search, ⌘P tasks, ⌘J topics, ⌘N new task, N outside inputs,
⌘[ back, ⌘B sidebar, ⌘⌥B right panel, ⌘⇧Enter maximize/restore, ⌘⌥Enter Done at
Review outside inputs, ⌘, Settings, ⌘/ shortcuts, Escape native dialog dismissal.
Ctrl substitutes for Command. Dialogs keep their own keyboard handling, including
⌘Enter to save/start a task; shortcut help remains available over a dialog.
Desktop Muster/Help menu accelerators send Settings/Shortcuts commands through the
existing bridge. Settings, project, and task copy is present in both dictionaries.

Tests cover migration, settings/notifications, key secrecy/revocation/usage,
external MCP catalog and denied calls, temporary-repository reads, traversal and
size/binary limits, attachment limits/auth/cleanup/cache, native notification
choices, bridge commands, sidebar persistence, settings, project tabs and task
input. Mock e2e additionally exercises external MCP over HTTP and actual attachment
delivery/cache. Visual inspection is deliberately left to manual light/dark,
English/Chinese and viewport review; no screenshots or desktop distribution build.

### Agent screenshot artifacts and local images

For project turns the daemon prepares `<MUSTER_HOME>/artifacts/<buildId>/` before
starting the runtime and adds its absolute path and a Markdown example to the
system instructions (including resumed sessions). Agents should save screenshots
there, or copy temporary tool output there during writable turns before linking
it. PLAN remains read-only: preparing the directory does not grant the runtime
write permission. Directories are reused across turns of the same build, isolated
between builds, and outside Git checkpoints and read-only cleanup. Creation errors
fail preparation rather than falling back to `/tmp`. Artifacts are retained; there
is no automatic retention policy yet. Removing them manually makes historical
image references unavailable. Prefer unique filenames per revision.

Both clients fetch local Markdown images via
`POST /api/todos/:todoId/images` with `{buildId,messageId,src}` and
`X-Muster-Image: 1`. The server joins the persisted Agent message, turn, build and
todo, checks the Markdown image reference, then applies file restrictions. Stream
fragments are not fetched until the message is persisted as complete. Relative
image paths are not resolved against a task worktree; agents must use the absolute
path from their instructions.

Allowed images are PNG, JPG/JPEG, GIF and WebP, at most 10 MiB each, with matching
extension/signature and a fixed image MIME type. The allowed roots are the build's
worktree, its artifact directory and the configured Muster data directory. The
`artifacts/` and `workspaces/` subtrees are checked **before** the data-directory
fallback: other builds and repository caches are excluded. Traversal, ambiguous
encoding, symlinks below trusted roots, hardlinks and non-regular files are denied.
Reads use no-follow file handles, bounded buffers and before/after path identity,
file size and modification checks. On Linux the open descriptor's real path is
also checked. These checks are not an OS sandbox against a malicious process
running as the same user; do not share writable data roots with untrusted users.
Malformed image data that passes its format signature still falls back safely if
the browser cannot decode it. SVG/HTML and arbitrary file downloads are unsupported.

Local provenance is established using `<dataDir>/machine.json`: its machine ID
must match the build's execution machine and its token must authenticate against
this server. Default workspaces are `<dataDir>/workspaces`. The default desktop
sets `MUSTER_HOME` and `MUSTER_DATA_DIR` to the same directory. Missing/mismatched
registration means **remote**, even if the server has an identical absolute path.
Custom workspaces, separate daemon/server homes, or shared filesystems require an
administrator-supplied `MUSTER_IMAGE_MAPPINGS` JSON array on the server, for example:

```json
[{"machineId":"<enrolled-machine-id>","sourceDataDir":"/daemon/muster","dataDir":"/mounted/muster","sourceWorkspacesDir":"/daemon/workspaces","workspacesDir":"/mounted/workspaces"}]
```

Each entry explicitly trusts those server-visible roots for that machine; do not
map unrelated local files onto a remote machine. Source paths should use the
canonical absolute paths reported by the daemon. Without a mapping, remote images
show an execution-machine notice and the path. There is no automatic file upload,
remote file proxy, or client-side access to a daemon's filesystem. Old `/tmp`
references remain unavailable; the new artifact instructions prevent this for
future deliverables.

The Web REST interface remains single-user and has no built-in login. Keep the
server loopback-only, or protect **all** routes (including this endpoint) with an
authenticated reverse proxy and TLS. Set `MUSTER_PUBLIC_URL` to the public origin
behind a proxy. The image endpoint requires a custom fetch header, rejects foreign
origins/cross-site fetches, does not enable CORS, and returns `private, no-store`,
`nosniff`, and `Cross-Origin-Resource-Policy: same-origin`. These are cross-site
protections, not user authentication; build IDs are not credentials.

Successful images support an accessible enlargement dialog. Missing, denied,
oversized, unsupported or undecodable images display a placeholder and a clickable
path which reveals selectable text. That fallback never invokes the desktop
`openPath` bridge, navigates to `file://`, or retries through another file API.
Ordinary non-image path links retain their existing native behavior. Blob URLs
are revoked when the image changes or unmounts.
