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

`npm run desktop:dist` first builds every workspace, stages the server/daemon/shared dist files with production dependencies and built web assets outside ASAR, and packages with electron-builder. npm workspace links are materialized into actual bundled directories, so the application has no checkout dependency. The Electron main/preload code is in ASAR. The icon generator rasterizes the existing Command mark into PNG/ICNS/ICO using Node alone. macOS uses explicit ad-hoc signing (`identity: "-"`) and emits an app plus DMG for the host architecture; no developer identity, notarization or installation is involved. On hosts where DiskImages cannot allocate virtual devices, the packager falls back to `hdiutil makehybrid -hfs`, creating a valid, uncompressed HFS distribution DMG without mounting; it includes the signed app and an Applications shortcut. Windows NSIS and Linux AppImage targets remain configured; their native packaging is not verified by a macOS build.

`npm run desktop:smoke` runs the packaged app with a hidden window and an isolated temporary data directory. It checks the rendered sidebar and preload, real SQLite server startup, automatic enrollment, a mock Chief turn interrupted by SIGTERM and persisted as `stopped`, then attachment to an externally running server that survives desktop quit. It saves a screenshot and logs in the printed temporary evidence directory. Tests never call real model APIs. The underlying `--smoke-test` flag keeps the window hidden, disables native notifications, and exits after startup verification; `--smoke-hold` allows the harness to exercise graceful shutdown. `MUSTER_DESKTOP_PORT` overrides the starting discovery port for isolated smoke runs.

On this restricted build host, native application registration aborts Electron in macOS LaunchServices before JavaScript starts, so GUI smoke validation remains unverified here. `npm run desktop:smoke -- --workers-only` independently verifies the packaged ASAR worker entry bridge, real production dependencies, automatic enrollment, bundled SQLite and persisted SIGTERM completion. It does not claim to verify the native window. The full default smoke command remains available on a normal macOS desktop session.

## Internationalization

Web copy lives in `apps/web/src/i18n`: the nested English dictionary defines `MessageKey` and the recursive `Messages` shape, enforced for Simplified Chinese (`zh-CN`). `I18nProvider` selects a validated `muster.locale` preference or detects Chinese from any `zh*` entry in `navigator.languages` (otherwise English), updates the HTML language/title and exposes `useI18n()`. Unsupported stored preferences fall back to detection. Dictionary modules and native picker names are discovered from the shared locale list. `t(key, params)` interpolates named values and selects `{one, other}` forms with `Intl.PluralRules`; date, relative time, number and duration helpers use the active locale. Phase, runtime and status labels have centralized dictionaries. Tests verify nonempty copy, placeholder parity and live language switching. Components rendered without a provider default to English, keeping isolated tests deterministic.

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

Both CLI processes receive the granted environment. Codex also gets `config.shell_environment_policy.set` on every thread start/resume, explicitly empty when no grants exist. This selects granted variables without disabling the default filter for unrelated inherited credentials. Claude's child Bash inherits the process environment. The daemon redacts literal granted values of at least six characters throughout event payloads and completion payloads (messages, tool data, errors, plans, diffs and session metadata). Secret-bearing message/reasoning deltas are buffered until complete/end-of-turn so values split across chunks cannot evade redaction; other turns retain normal streaming. This is literal replacement, not detection of encoded/transformed secrets. It cannot scrub files committed by a runtime, CLI-local histories, external service logs, or unrelated machine credentials. Self-hosted runtimes execute as the daemon's OS user; these grants are delivery controls, not isolation from that user's existing credentials or the loopback API.

When `pushBranch` is true, a successful writable runtime result is checkpointed and the task branch is pushed to the repository origin. Failed/stopped/plan turns never trigger this automatic push. This permission does not change the existing user-authorized merge-to-base flow, nor prevent a full-access runtime from invoking git itself.

### Verified facts and limits

Checked on the installed **codex-cli 0.162.1** with `app-server generate-ts` and `generate-json-schema`: `ThreadStartParams` and `ThreadResumeParams` accept a JSON `config`; `SandboxPolicy` has `readOnly {networkAccess:boolean}` and no additional read-root field. The [official config schema](https://developers.openai.com/codex/config-schema.json) defines `ShellEnvironmentPolicyToml.set` as a string map, and the [advanced configuration guide](https://learn.chatgpt.com/docs/config-file/config-advanced) describes the shell environment policy. Model-free protocol peers assert the actual adapter payload on new/resumed threads and the subprocess environment; a Claude peer launches a real `/bin/sh` child to verify inheritance. No paid model API is called.

**Host limitation:** starting the installed Codex sandbox is rejected here with `sandbox-exec: sandbox_apply: Operation not permitted`. A direct installed app-server configuration-read attempt also fails because this task cannot initialize SQLite state under `/Users/wale/.codex`. Therefore actual 0.162.1 sandbox reads outside a worktree and real model-issued shell environment propagation are not claimed as verified. Plan SKILL.md inlining avoids depending on those reads; optional supporting-file access still needs validation on an unrestricted daemon host. Protocol-peer checks and generated types establish our wire contract, not full CLI execution acceptance.

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
