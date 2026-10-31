# Muster architecture and contracts

This document describes the integrated server, daemon, and web contract. JSON field names are camelCase. Unless a route says otherwise, successful REST responses are `{ "data": ... }`; errors are `{ "error": string, "details"?: ZodIssue[] }`. IDs are UUID strings and timestamps are ISO 8601 strings.

Muster has three ideas:

- A **workspace** is one Git repository (stored as a `project`). Each workspace has a **master agent** and one main conversation with it (a `topic`).
- The master agent splits goals into **tasks** (stored as `todos`), assigns them to coding agents, follows them up and accepts the results. Every task runs in its own Git worktree and branch, and every step of its execution is streamed and stored.
- Other AIs reach a workspace's master agent through an authenticated **MCP** endpoint to hand it work and watch progress.

## Packages and runtime

- `packages/shared` exports the domain models, input schemas, board/phase helpers, `TurnJob`, `AgentEvent`, `TurnCompletePayload`, and `ServerEvent`.
- `apps/server` exports `createApp(options)` for embedding/tests and starts an `@hono/node-server` listener from `index.ts`. `workspaces.ts` creates workspaces and tasks and posts to master agents for both REST and MCP.
- Node.js 22 or newer is required. The server uses built-in `node:sqlite` in synchronous WAL mode.
- `MUSTER_DATA_DIR` defaults to `~/.muster`; the database is `<data dir>/muster.db`. `HOST` defaults to `127.0.0.1`, `PORT` defaults to `7420`; `MUSTER_PUBLIC_URL` defaults to `http://127.0.0.1:<port>`. `MUSTER_CLAIM_WAIT_MS` controls long-poll duration (default 25000). Set `MUSTER_CHIEF_AUTO_FOLLOW_UP=false` to stop master agents from following up task notices automatically.
- If `MUSTER_ENROLL_KEY` is set, machine enrollment requires that value in `X-Muster-Enroll-Key` or a Bearer header.
- In production, `apps/web/dist` is served when it exists, with `index.html` as the SPA fallback.

The migration runner uses SQLite `user_version`; `migrations.ts` runs on startup and `db/schema.sql` is a current-schema reference. Notable fields:

- `projects.chief_agent_id` names the workspace's master agent; null means the default master agent (the seeded `Chief`, `is_chief = 1`, which cannot be deleted). Deleting an agent that leads a workspace returns that workspace to the default.
- `topics.project_id` (unique) links each workspace to its main conversation, created together with the workspace and renamed with it. A build with nullable `todo_id` and branch `chief:<topicId>` is the internal conversation container for master-agent turns. Task builds always have a todo and a `muster/conv-<buildId>` branch.
- `todos.topic_id` is the workspace conversation; `todos.previous_gate` is `review` or null and preserves Review across revise, close and reopen.
- `turns.session_state_json`, `turns.stop_requested`, `turns.not_before` and the claim-time `agent_snapshot_json` carry runtime resume state, cooperative cancellation, follow-up debounce and history that agent edits cannot rewrite. `event_batches`, `machine_claims` and `server_events` make uploads, claims and SSE replay idempotent. The event log drops events older than 24 hours while always keeping the newest 5,000; a client whose `Last-Event-ID` predates it gets one `sync.reset` event.
- The workspace migration (10) adds the two columns above, creates a conversation for every existing project, stops queued plan turns, returns planning/confirm tasks to the backlog, deletes plan documents, and drops the `schedules`, `secrets`, `agent_memories` and `attachments` tables. Older topics without a workspace keep their history but are no longer shown.

On first start, Muster creates the default master agent `Chief` (`codex`, `default`, reasoning `medium`; shared `CHIEF_MODEL`). Shared `DEFAULT_MODELS` is `default` for every CLI runtime — Muster passes no model and the CLI uses its own configured one — and `mock` for Mock.

## Local commands

- `npm install` installs all workspaces and prepares the daemon binary.
- `npm run dev` builds shared and starts server on 7420 plus Vite on 5173 concurrently. It stops both processes on interruption or a child failure. Watchers use polling by default; `CHOKIDAR_USEPOLLING=false` opts into native watching.
- `npm run daemon` builds shared and daemon, then starts against `http://127.0.0.1:7420`; extra flags such as `-- --concurrency 2` are forwarded. `MUSTER_HOME` controls the daemon's registration and workspaces; `MUSTER_DATA_DIR` controls server data.
- `npm run build && npm start` serves the built web app and API from 7420. Static paths resolve relative to the server module, independent of launch cwd.
- `npm run e2e` expects built packages. It starts a child server with an isolated `MUSTER_DATA_DIR` on an ephemeral port and a mock-only daemon. It verifies a real local Git merge, mid-turn steer delivery, concurrent isolated worktrees, a partner AI handing work to a master agent over the workspace MCP endpoint, production SPA routes, and SSE replay. All temporary data and processes are cleaned up.
- Vite proxies `/api` (including SSE) and `/mcp` to 7420. Remote daemons require a reachable `MUSTER_PUBLIC_URL`; set `HOST` explicitly to bind beyond loopback.

## REST API

The `{data: ...}` envelope applies to the web-facing `/api` routes, not the machine protocol, whose exact top-level responses are documented separately.

### Request security

Every route except `/health` passes one middleware that assumes the browser can be hostile. The `Host` hostname must be a loopback name (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), the hostname of `MUSTER_PUBLIC_URL`, or one listed in `MUSTER_ALLOWED_HOSTS`; anything else gets `403 {error: "Host not allowed"}`, which stops DNS-rebinding pages from reading responses or reaching any endpoint, including `/api/machine`, `/api/mcp`, `/mcp` and the static app. Unsafe methods (anything but `GET`, `HEAD` and `OPTIONS`) additionally require a same-origin `Origin`, when one is present, or the `MUSTER_PUBLIC_URL` origin, and reject `Sec-Fetch-Site: cross-site`; requests without an `Origin` header (curl, the daemon, MCP clients) are accepted, and the `Host` check still applies. Route bodies must declare `application/json` (`; charset=...` and `+json` suffixes are fine), so a `text/plain` POST from another page cannot be parsed as JSON and is answered `415 {error: "Expected application/json"}` before its handler runs. Multipart uploads (skills) are covered by the origin rule. Unmatched `/api` and `/mcp` paths answer `404 {error: "Not found"}` instead of the SPA document.

### Workspaces

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/projects` | `Project[]` |
| POST | `/api/projects` | `{name, repoUrl, baseBranch?, description?, chiefAgentId?}` → `Project` (201; branch defaults to `main`); also creates the workspace conversation |
| GET | `/api/projects/:id` | `Project` |
| PATCH | `/api/projects/:id` | any of `{name, repoUrl, baseBranch, description, chiefAgentId}` → `Project`; `chiefAgentId: null` restores the default master agent |
| DELETE | `/api/projects/:id` | 204; 409 while it has tasks or its master agent has queued/running work |

`Project = {id, name, repoUrl, baseBranch, description, chiefAgentId, topicId, createdAt}`. Unknown agents return 422.

### Agents

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/agents` | `Agent[]` (default master agent first) |
| POST | `/api/agents` | `{name, role, runtime, model, reasoning?, avatar?, permissions?, defaultSkillIds?, connectionIds?}` → `Agent` (201) |
| GET | `/api/agents/:id` | `Agent & {inProgress: Todo[], workspaces: Project[], skillCount}`; `workspaces` are those it leads |
| PATCH | `/api/agents/:id` | any create field → `Agent` |
| DELETE | `/api/agents/:id` | 204; the default master agent cannot be deleted; agents with queued/running work return 409 |

Any agent can be a workspace's master agent; its role is appended to the master-agent instructions. `runtime` is an id from the shared `RUNTIMES` catalog (`packages/shared/src/runtimes.ts`). `permissions` is `{createSkills, updateSkills}`; unknown permission keys from older data are dropped. `Agent = {id, name, role, runtime, model, reasoning, avatar, isChief, permissions, defaultSkillIds, connectionIds, createdAt, updatedAt}`.

### Machines

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/machines` | `Machine[]`, augmented with `online` and `running` |
| POST | `/api/machines/refresh-models` | asks every machine to list its runtimes' models on its next heartbeat (202) |

`Machine = {id, name, concurrency, runtimes, models, lastSeenAt, createdAt, online?, running?}`. A machine is online when its last heartbeat is less than 30 seconds old.

### Tasks and actions

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/todos` | `Todo[]`; filters: `phase`, `projectId`, `agentId` |
| POST | `/api/todos` | `{projectId, title, spec?, agentId?, createdBy?, start?}` → `Todo` (201); `start:true` queues it immediately; unknown workspace/agent → 422 |
| GET | `/api/todos/:id` | `Todo & {builds: (Build & {turns: Turn[], documents: Document[]})[]}` |
| PATCH | `/api/todos/:id` | any of `{title, spec, agentId}` → `Todo`; unknown agent → 422 |
| DELETE | `/api/todos/:id` | closes rather than physically deleting; 204 |
| POST | `/api/todos/:id/start` | `{agentId?}` → `{turnId}` (202) |
| POST | `/api/todos/:id/message` | `{content}` → `{queued, turnId?}` (202) |
| POST | `/api/todos/:id/done` | `{merge?: boolean}` → `{turnId: string|null}`; merge defaults true and returns 202, no-merge completes immediately |
| POST | `/api/todos/:id/close` | no body required → `Todo` |
| POST | `/api/todos/:id/reopen` | no body required → `Todo` |
| POST | `/api/todos/:id/rerun` | `{strategy: "continue"|"restart"}` → `{turnId}` (202) |
| POST | `/api/todos/:id/stop` | no body required → `{stopRequested:true}` (202) |

`Todo = {id, number, projectId, title, spec, phase, agentId, createdBy, topicId, previousGate, createdAt, updatedAt, doneAt}`. `phase` is `todo | queued | building | review | failed | done | closed`. Start is only valid from `todo`, done from `review`, rerun from `failed`, and reopen from `done`/`closed`. Invalid actions return 409. Feedback during a running turn is copied into `queued_messages`; feedback at Review enqueues a `revise` turn that returns to Review. Stop is cooperative for running work: heartbeat returns the requested turn in `stop` until the daemon completes it as stopped. A queued stop cancels immediately into `failed`. Reopen waits until a closed running turn has acknowledged its stop.

### Conversations, documents and the master agent

| Method | Path | Request / response |
|---|---|---|
| GET | `/api/conversations/:id/messages` | `Message[]` in creation order; the ID is a build ID for task work or the workspace's `topicId` for its master agent |
| GET | `/api/todos/:id/documents` | all `Document[]` across the task's builds |
| GET | `/api/todos/:id/documents/:kind/:version` | latest matching `Document`; kind is `changes` |
| GET | `/api/topics/:id` | `Topic` (includes persisted `activity` and `activeTurnId`) |
| POST | `/api/topics/:id/messages` | `{content}` → `{turnId}` (202), queues a turn of that workspace's master agent |

`Message = {id, conversationId, turnId, role, content, meta, createdAt}`. Every message includes its true `turnId`, creation timestamp, and a monotonic `meta.revision`. Tool start/completion events are messages with role `tool` and the complete event in `meta`. Agent deltas append to one agent message for the turn. `Document = {id, buildId, kind, version, content, createdAt}`: one `changes` diff per completed build or revise turn, versioned per build. Builds carry the summed `tokensIn`, `tokensOut` and `durationMs` of their turns.

### Queued steering

- `GET /api/conversations/:id/queued-messages` returns pending `QueuedMessage[]`: `{id, conversationId, content, createdAt, deliveredAt:null, delivering}`.
- `PATCH /api/conversations/:id/queued-messages/:messageId` with `{content}` edits undelivered, unreserved feedback; `DELETE` retracts it (204). In-flight or delivered messages return 409.
- Inbox GET reserves delivery but does not consume the message. An explicit ACK removes it from the pending tray. On successful completion at Review, all remaining feedback (including unacknowledged reservations) is atomically promoted, in order, into the opening prompt of one revise turn. Completion retries cannot enqueue duplicate revisions. Failed, stopped, or closed work releases reservations and retains pending feedback without automatically restarting it.
- Master-agent `activity` (`idle|queued|running`) and `activeTurnId` are derived from persisted turns and survive refresh and restart.

## Task orchestration

Starting creates an active build and a queued `build` turn. Claim atomically changes the turn to running and the task to `building`. Successful completion maps `build` and `revise` to `review`, and `merge` to `done`. Failed/stopped turns enter `failed`, except a merge conflict/error or offline merge returns the task to `review`. A merge requires explicit `{merge:{ok:true}}` confirmation before Done. Completing a turn after its task was closed does not reopen it. `rerun:continue` keeps the active build/session lineage; `rerun:restart` creates a new build and branch with no runtime session. Both retain the failed request, including revision feedback. Merge-free Done immediately marks the active build done.

When a task enters `review`, `failed`, or `done`, the server appends a system message `Task #<n> <title> (taskId <id>) entered <phase>.` to its workspace conversation. With auto-follow-up enabled, `review` and `failed` also queue a turn of the workspace's master agent, for every task in the workspace whoever created it. Automatic follow-ups merge notices into the next queued master-agent turn per workspace; an automatic turn becomes claimable after three seconds without new notices (`turns.not_before`, so batches survive restarts). A running turn is never modified: new notices accumulate in at most one queued successor. Notices can also join an existing user-requested turn without delaying it. Each workspace's notices go only to its own master agent.

The master agent's instructions tell it to coordinate rather than implement, split goals into parallel tasks, and follow each one up: at review it inspects the diff (`get_task`) against the spec and either accepts it with `complete_task` (merging the branch) or sends precise feedback with `send_task_message`; on failure it reads the log and reruns or reports. It asks the user first only when they asked to review a task themselves, the change is risky, or it is unsure. Its instructions include the workspace name, id, repository, base branch and description, and its tools default to that workspace.

Task `systemInstructions` contain only the agent role and platform conventions (isolated worktree/branch, checkpoints, MCP tools). Every task prompt starts with the current instruction — implement the task, address the feedback, or merge — before the task number/title/spec and feedback, and that instruction overrides earlier ones, because runtime sessions can retain the first turn's system instructions. All task turns are writable.

A successful build or revision with `diff:""` still enters Review and stores the empty changes document, and appends the system message `No file changes in this build` to the build conversation. Completion retries do not duplicate it. An omitted diff is unknown, not evidence of no changes.

On the board, running task cards show the latest line of the agent's output or the tool it just started, from the same SSE events that stream into the task page.

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

Session state is resolved at claim time from the immediate preceding terminal turn only. A missing state or changed agent/runtime/model forces a new session.

`TurnJob`:

```ts
{
  turnId: string;
  buildId: string;
  todoId: string | null; // null for a master-agent turn
  topicId: string | null; // the workspace conversation for a master-agent turn, null for task work
  kind: "build" | "revise" | "merge" | "chief";
  task?: {number: number; title: string; summary: string; url: string};
  project: {id: string; repoUrl: string; baseBranch: string} | null; // null for master-agent turns
  branch: string | null;
  agent: {runtime: Runtime; model: string; reasoning: string | null; role: string};
  prompt: string;
  systemInstructions: string;
  sessionState: Record<string, unknown> | null;
  skills?: {slug: string; name: string; description: string; version: string}[];
  connections?: TurnConnection[];
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

`TurnCompletePayload = {status:"done"|"failed"|"stopped", headCommit?, baseCommit?, diff?, usage?:{tokensIn,tokensOut,durationMs}, error?, sessionState?, merge?:{ok,error?}}`. A supplied `diff` (including an empty string) creates the next changes document version. Usage is accumulated exactly once on the build, with an immutable per-turn breakdown. `baseCommit` is recorded on the first completion that supplies it. Runtime state is used by later turns and also copied to the workspace conversation for master-agent turns. `plan.updated` events from runtimes stream like other activity but no longer create documents.

## SSE

`GET /api/events` returns `text/event-stream`. It begins with a `connected` comment, sends 15-second ping comments, and emits each event as:

```ts
{ id: string; type: string; todoId?: string; conversationId?: string;
  turnId?: string; messageId?: string; message?: Message; payload: unknown }
```

`id:` is a persistent monotonic SQLite cursor in each SSE frame. Reconnects use `Last-Event-ID`; events after that cursor replay in order, including across server restarts. Entity event types are `project.changed|deleted`, `agent.changed|deleted`, `machine.changed|deleted`, `todo.created|changed`, `topic.changed|deleted`, `document.created`, `message.created|updated|deleted`, `message.queued|queue_changed|delivered`, `turn.queued|started|completed|stop_requested`. Every ingested `AgentEvent.type` is also broadcast unchanged (`message.delta`, `tool.started`, and so on), with its original event in `payload`. Message deltas/completions additionally carry stable `turnId`, `messageId`, and the complete updated `message` with `meta.revision`. The web upserts by ID and revision instead of concatenating replayed deltas, and merges history fetches against buffered revisions.

## MCP

Muster serves the same tool set to three kinds of callers. Tool results contain a JSON text content item and `{result: value}` structured content.

| Caller | Endpoint and credential | Scope |
|---|---|---|
| A workspace's master agent | `/mcp` with the per-turn token from `TurnJob.mcp.token` | its own workspace; can manage tasks, create agents, list/grant/revoke connections, and use skill tools within its permissions |
| A coding agent on a task | `/mcp` with the per-turn token | read-only workspace tools, plus skill tools within its permissions |
| Another AI | `/api/mcp` or `/api/mcp/workspaces/:id` with `Authorization: Bearer <API key>` | `read` keys get the read-only tools; `chief` keys also manage tasks and `assign_work`. The workspace endpoint confines every tool to that workspace and defaults `workspaceId` to it; an unknown workspace returns 404 |

`/mcp` uses the MCP SDK's stateful Streamable HTTP transport with JSON responses. Turn tokens are accepted only while their turn is running, not stopping, and both machine heartbeat and turn lease are current. Machine tokens cannot authenticate MCP. Transport sessions are scoped to the turn token, so another turn cannot reuse the session ID; a turn may initialize several sessions (ACP agents restart their MCP servers), up to 8. `/api/mcp` is stateless: each request authenticates the key again, so revocation applies immediately; after 20 failed attempts per minute it answers 429.

Read tools (all callers):

| Tool | Input | Result |
|---|---|---|
| `list_workspaces` | none | workspaces with `masterAgent`, `masterActivity` and `taskCounts` by phase |
| `get_workspace` | `{workspaceId?}` | the workspace summary and all its tasks |
| `list_tasks` | `{workspaceId?, phase?}` | tasks, newest first |
| `get_task` | `{taskId}` | the task, its builds and turns, and each build's latest diff (clipped to 60,000 characters) |
| `get_task_log` | `{taskId, limit?=40}` | the latest messages of the task's current build: agent output, tool calls (`tool`), system notices |
| `list_agents` | none | agents |
| `list_skills` | none | skills |
| `read_master_conversation` | `{workspaceId?, limit?=20}` | API keys only: recent messages of the workspace conversation and `masterActivity` |

Management tools (master agents and `chief` keys):

| Tool | Input |
|---|---|
| `assign_work` | API keys only: `{workspaceId?, content}` — posts to the master agent and queues its turn → `{workspaceId, turnId, status}` |
| `create_task` | `{workspaceId?, title, spec?, agentId?, start?=true}`; `createdBy` is `chief` for master agents and `user` for API keys |
| `start_task` | `{taskId, agentId?}` |
| `send_task_message` | `{taskId, content}` — steers a running turn or revises at review |
| `complete_task` | `{taskId, merge?=true}` |
| `rerun_task` | `{taskId, strategy?="continue"}` |
| `stop_task` | `{taskId}` |
| `close_task` | `{taskId}` |

`workspaceId` may be omitted on the global endpoint only when there is exactly one workspace. A master agent or workspace-scoped key that names another workspace, or a task in one, gets a tool error.

## Runtime integration and remaining limits

Codex uses `codex app-server` with fresh per-thread `config.mcp_servers.muster.{url,required:true,default_tools_approval_mode:"approve",http_headers:{Authorization}}` on both start and resume. Required MCP initialization fails the thread if the board is unavailable. Phase-agnostic `systemInstructions` are passed as `developerInstructions` on start/resume. Every `turn/start` explicitly sets `approvalPolicy:"never"` and `sandboxPolicy: {type:"dangerFullAccess"}`; start/resume also set `sandbox: "danger-full-access"`. All task and master-agent turns are writable now that plan turns are gone.

Protocol facts checked locally with `codex-cli 0.162.1`, using `codex app-server generate-ts --out <temporary-dir>` (and a separate `--experimental` generation):

- `v2/ThreadStartParams.ts` and `v2/ThreadResumeParams.ts` accept `developerInstructions`, `approvalPolicy`, and the string `sandbox` mode. Accepting resume configuration does not establish that it replaces earlier instructions already present in model history; phase rules therefore live in each turn's prompt.
- Stable `v2/TurnStartParams.ts` has no direct `developerInstructions` field. It accepts `approvalPolicy` and `sandboxPolicy`, documented as overrides for this turn and subsequent turns. Muster sends them every turn so transitions in either direction are explicit.
- This generated `v2/SandboxPolicy.ts` uses camelCase discriminants: `readOnly` requires the boolean `networkAccess`; `dangerFullAccess` has no extra fields. These differ from the hyphenated thread-level sandbox strings.
- Experimental `turn/start.collaborationMode.settings.developer_instructions` exists and takes precedence over model/effort/developer instructions. Muster does not depend on this experimental mode or raw history injection.

The [official App Server turn documentation](https://learn.chatgpt.com/docs/app-server#turns) confirms per-turn sandbox overrides and their persistence into subsequent turns. Generated types from the installed CLI determine the exact wire shape (newer online docs can differ). HTTP headers follow the [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

MCP tool approval is separate from filesystem sandboxing. Under `approvalPolicy:"never"`, a tool that needs approval is rejected, not implicitly approved. This used to make read-only turns fail Muster context lookups. Muster now auto-approves only its own authenticated platform server using `mcp_servers.muster.default_tools_approval_mode:"approve"`. This covers every turn kind, including state-changing platform tools, without changing other MCP servers' approval defaults or the server's per-turn token checks. No global approval/reviewer setting is relaxed.

Approval findings checked with `codex-cli 0.162.1`:

- Generated `ThreadStartParams` and `ThreadResumeParams` accept the JSON `config` override; `TurnStartParams` has no MCP config field. The daemon therefore supplies the Muster server policy on every start/resume and retains explicit sandbox/approval overrides on every turn.
- Generated TS `v2/AppToolApproval.ts` and JSON Schema `v2/ConfigReadResponse.json` enumerate `auto|prompt|writes|approve`. The [official config schema](https://developers.openai.com/codex/config-schema.json), `RawMcpServerConfig`, places `default_tools_approval_mode` under each MCP server and per-tool overrides under `tools.<name>.approval_mode`. The installed parser independently confirms these values: `codex -c 'mcp_servers.muster={url="http://127.0.0.1:1/mcp",default_tools_approval_mode="invalid"}' debug prompt-input` rejects the value and lists the four accepted modes before executing anything.
- A local Responses fixture drove synthetic tool calls through the installed app-server and a local MCP fixture, with no real model API calls. With `approvalPolicy:"never"` (checked on a read-only thread/turn when plan turns existed), the results were:

  | Server approval mode | Unannotated tool | Tool with `annotations:{readOnlyHint:true}` |
  |---|---|---|
  | omitted / `auto` | rejected: `MCP tool call requires approval, but approval policy is never` | executes |
  | `writes` | rejected with the same error | executes |
  | `prompt` | rejected with the same error | rejected with the same error |
  | `approve` | executes | executes |

  This is a model-free approval-path check, not a live `gpt-6.1-sol` acceptance run. The thread response retained `{type:"readOnly",networkAccess:false}` with `approve`. Direct client `mcpServer/tool/call` requests do not exercise the model's approval gate and cannot establish this behavior by themselves.
- `enabled_tools` is a tool-catalog allowlist, not approval. `writes` plus read-only annotations would still reject platform mutations. Generated `AskForApproval` granular settings control categories of approval requests (including MCP elicitation), not server-specific automatic tool approval. A server-local `approve` default is the narrowest setting covering all Muster platform tools; per-tool overrides remain available for exceptions. See the [official MCP options](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options).

The server advertises `annotations:{readOnlyHint:true}` only on the read tools listed under [MCP](#mcp). Mutating tools are not marked read-only. The annotation is honored by Codex's default/`writes` approval paths, but is not a substitute for the explicit Muster server policy. Model-free daemon protocol-peer tests assert that policy is scoped to Muster on both new/resumed threads for build, revise, merge, and master-agent turns; they also assert the full-access sandbox and `never` policy. The server catalog test verifies the read-only annotations over MCP.

Claude uses `--mcp-config` with `{mcpServers:{muster:{type:"http",url,headers:{Authorization}}}}` on each process, plus stream-json input/output and partial messages. `--append-system-prompt` receives the same instructions across a task's turns, and the current instruction arrives in each user message, avoiding a stale-instruction hazard with `--resume`. `--system-prompt-snapshot off` remains enabled. Every turn uses permission mode `bypassPermissions`. Optional reasoning is passed as `--effort`. CLI flags were checked against local Claude Code 2.1.310. Protocol-peer tests assert the actual URL and bearer header for both adapters and the Codex turn sandbox policy on new/resumed threads without calling a real model API.

pi and omp use `pi --mode rpc`: JSONL commands (`prompt`, `steer`, `abort`, `get_state`, `extension_ui_response`) and events (`message_update` text/thinking deltas, `message_end` with per-call usage, `tool_execution_start/end`, `agent_end`). A turn ends after `agent_end` once `get_state` reports the session file, which is stored as `sessionState.sessionFile` and resumed with `--session` if it still exists. Extension dialogs are cancelled because nobody is at the machine. Every turn writes a private temporary bridge directory (0700; config 0600, removed when the turn ends) holding a dependency-free MCP Streamable HTTP/stdio client, and a pi extension that registers each MCP tool via `pi.registerTool` (plain JSON Schema parameters, which pi-ai validates).

ACP runtimes (including `qodercli --acp` and `droid exec --output-format acp`) run `initialize` (protocol 1, no client fs/terminal), then `session/resume` / `session/load` (history replay suppressed) or `session/new` with Muster's MCP endpoint and granted connections. HTTP servers are passed only when `mcpCapabilities.http` is advertised; otherwise each one becomes a stdio server running the bridge's proxy under the daemon's Node (`ELECTRON_RUN_AS_NODE=1` for the desktop bundle). A model other than `default` is set with a `model` config option, else `session/set_model` (an agent that lists models rejects unknown ids up front); reasoning maps to a `thought_level` option when offered. `session/request_permission` picks `allow_always`/`allow_once`; other agent→client requests return `-32601`. The session takes the most permissive mode offered (for example Droid's `auto-high`). `session/update` maps message/thought chunks, `tool_call(_update)` and `plan`; text before a tool call is completed as its own message and the last one becomes the plan text. Steering is queued and sent as the next `session/prompt` of the same turn; interrupt sends `session/cancel`. `sessionState` keeps `sessionId` and a hash of the instructions that led the session's first prompt.

The turn MCP endpoint (`/mcp`) keeps one Streamable HTTP session per `initialize` under a turn token (at most 8, oldest dropped), because ACP agents such as Hermes restart their MCP servers within a turn; requests route by `mcp-session-id`, and an unknown or another turn's session id gets 404.

`JsonProcess` frames stdout on LF only (Node `readline` also splits on U+2028/U+2029, which are legal inside JSON strings); pi and ACP processes keep non-JSON stdout lines as diagnostics instead of failing. The daemon resolves each runtime to an absolute executable (`locateRuntimes`), re-enrolling when the detected set changes.

Mock master-agent messages beginning `/split` use the real MCP SDK client to read their workspace (`get_workspace`) and agents, then `create_task` two independent tasks for the first non-default mock agent, which start immediately. Tool calls/results are persisted as normal tool messages. Other mock master-agent prompts produce a deterministic reply. Coding mock turns append to `MUSTER_MOCK.md` in their isolated worktree.

Steer delivery is at least once across a daemon crash between runtime acceptance and ACK. Within a running daemon, a lost ACK retries without steering twice. Durable exactly-once model injection would require adapter-level message IDs. Builds cannot migrate live worktrees/sessions between machines; use restart if the assigned machine is unavailable. Machine enrollment itself has no retry key, and is not retried on ambiguous failures. SSE/idempotency journals currently have no retention pruning. Live paid model runs are outside automated tests; only local protocol inspection and model-free peers are exercised.

## Desktop

`apps/desktop` is an Electron + strict TypeScript workspace. The main process discovers a local server starting at 7420, recognizes Muster using `/health` (with a compatibility check of `/api/topics` for older servers), attaches when possible, and skips ports occupied by unrelated services. An owned server binds only to loopback and serves the bundled web dist. Both server data and daemon home default to `~/.muster`; `MUSTER_DATA_DIR` overrides the desktop's whole data directory. The daemon automatically enrolls with the selected origin. A matching already-running CLI daemon is reused, while a daemon connected to another server produces an actionable startup error.

Workers use `child_process.fork` with `execPath: process.execPath`, `execArgv: []`, and `ELECTRON_RUN_AS_NODE=1`. No system Node is needed. **Verified on macOS arm64 with Electron 45.0.0: bundled Node 24.22.0 imports `node:sqlite`, opens an in-memory database, and returns SQLite 3.53.4 without `--experimental-sqlite` or native addons.** The server and daemon retain their existing entrypoints and dependencies. The small worker entry bridge preserves main-module detection and supports cooperative SIGTERM semantics through IPC on Windows, where native `kill(SIGTERM)` would terminate immediately. See Electron's [run-as-Node documentation](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node) and [process model](https://www.electronjs.org/docs/latest/tutorial/process-model).

On quit, the app sends SIGTERM to its daemon, aborts pending claim/heartbeat/inbox requests and polling sleeps, interrupts running turns and lets them report `stopped` before stopping its server. Idle shutdown does not wait for the 25-second claim poll. The server rolls back claims if the connection closes before the response finishes, including the turn assignment, MCP token and initial build affinity. Each owned worker has a 10-second grace period before SIGKILL; if reporting cannot finish, the daemon journal remains available for recovery on restart. Attached servers/daemons are never stopped. SIGINT/SIGTERM to the desktop also use this cleanup path. Single-instance locking prevents two desktop claim loops.

The daemon receives a PATH resolved through the user's `$SHELL -ilc` login shell (bounded to five seconds, with marked output to discard startup chatter). It retains inherited absolute PATH entries and appends `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin` and standard Unix system directories. Windows retains its native PATH. User CLIs and Git still need to be installed/authenticated separately.

The BrowserWindow loads only the local origin, disables renderer Node integration, enables context isolation and sandboxing, starts against a dark background, and remembers visible window bounds. A bundled CommonJS preload exposes only `window.muster.desktop`, platform, a native folder picker, opening absolute paths, and subscriptions to menu/notification commands. Main-process IPC handlers verify the sending window, frame and origin. HTTP(S) links open externally; other external schemes are denied. macOS traffic-light padding and drag regions are scoped to desktop-only CSS classes. The browser UI retains its normal layout.

The main process watches replayable SSE for Review/Failed/Done notifications (each switchable in Settings), and polls status for the Needs-you dock badge and machine/running tray status. Notification clicks focus the task through the preload command subscription. Native menus, dialogs and notifications are in Chinese. Standard native menus include New task (CmdOrCtrl+N), Open in browser and Show logs. Logs are `<data dir>/logs/{desktop,server,daemon}.log`; the daemon also keeps its usual `daemon.log` at its home.

`npm run desktop:dev` and the distribution script check the Electron executable and run `node node_modules/electron/install.js` if it is missing (including installs that skipped lifecycle scripts). Download failures report the installer command and network/proxy troubleshooting context.

`npm run desktop:dist` first builds every workspace, stages the server/daemon/shared dist files with production dependencies and built web assets outside ASAR, and packages with electron-builder. npm workspace links are materialized into actual bundled directories, so the application has no checkout dependency. The `beforeBuild` hook returns false to mark these dependencies as externally handled: unlike `npmRebuild: false`, this also skips redundant dependency collection for main/preload, which have no npm runtime dependencies. This is needed on hosts where `npm prefix -w` returns an invalid workspace root; it does not change the staged runtime dependencies. The Electron main/preload code is in ASAR. The icon generator rasterizes the existing Command mark into PNG/ICNS/ICO using Node alone. macOS uses explicit ad-hoc signing (`identity: "-"`) and emits an app plus DMG for the host architecture; no developer identity, notarization or installation is involved. On hosts where DiskImages cannot allocate virtual devices, the packager falls back to `hdiutil makehybrid -hfs`, creating a valid, uncompressed HFS distribution DMG without mounting; it includes the signed app and an Applications shortcut. Windows NSIS and Linux AppImage targets remain configured; their native packaging is not verified by a macOS build.

macOS packaged startup validates the real bundle path before creating the Muster data directory, acquiring the application lock or starting workers. Only `/Applications` and `~/Applications` installations are accepted; symlinks to release copies do not qualify. Other locations offer localized Move to Applications / Quit actions. Moving is permitted only when neither Applications destination exists, and Electron's conflict handler rejects replacement even if a destination appears during the move. Cancellation/failure never starts services. Existing installations must be updated manually. Development and non-macOS launches retain their existing behavior.

The distribution script checks process executable paths and bundle identities before staging or packaging. A `dev.muster.desktop` process inside this checkout's real release directory blocks packaging with its PID/path; inspection errors also fail the command. It neither stops processes nor changes the fixed output layout. This check is not atomic: do not start old release copies during a build. Both normal and fallback DMG success paths unregister only the generated release bundle with `lsregister -u`. Unregistration is idempotent: `kLSApplicationNotFoundErr` (`-10814`) from a never-registered bundle is success. Other command failures are warnings and do not fail an otherwise completed package; installation-path validation remains the primary defense. The release-boundary check still rejects paths outside release. Unregistration cannot stop an existing instance or permanently prevent registration. Single-instance locking and `open` do not establish the installed path; startup logs include executable, resources and bundle paths.

The smoke harness changes only its temporary macOS copy to `dev.muster.desktop.smoke`, re-signs it ad hoc, and verifies its identity before launch. Only that identity together with smoke arguments and a separate absolute data directory bypasses installation validation. Readiness evidence includes executable/resources paths and bundle identity, which the harness asserts against its copy. The production bundle cannot bypass installation checks using only `--smoke-test`. Worker-only verification retains the packaged Node bridge flow.

`npm run desktop:smoke` runs the packaged app with a hidden window and an isolated temporary data directory. It checks the rendered sidebar and preload, real SQLite server startup, automatic enrollment, a mock master-agent turn in a fresh workspace interrupted by SIGTERM and persisted as `stopped`, then attachment to an externally running server that survives desktop quit. It saves a screenshot and logs in the printed temporary evidence directory. Tests never call real model APIs. The underlying `--smoke-test` flag keeps the window hidden, disables native notifications, and exits after startup verification; `--smoke-hold` allows the harness to exercise graceful shutdown. `MUSTER_DESKTOP_PORT` overrides the starting discovery port for isolated smoke runs.

On this restricted build host, native application registration aborts Electron in macOS LaunchServices before JavaScript starts, so GUI smoke validation remains unverified here. `npm run desktop:smoke -- --workers-only` independently verifies the packaged ASAR worker entry bridge, real production dependencies, automatic enrollment, bundled SQLite and persisted SIGTERM completion. It does not claim to verify the native window. The full default smoke command remains available on a normal macOS desktop session.

## Skills

`skills(id, slug UNIQUE, name, description, source_json, created_at, updated_at)` holds the library; files live under the server data directory's `skills/<slug>/`. `createApp` accepts `dataDir` and an injectable `githubFetcher`. Resource content is never written to global Codex/Claude configuration directories.

| Method | Route | Result / behavior |
| --- | --- | --- |
| GET | `/api/skills` | Library metadata, including a SHA-256 content version. |
| POST | `/api/skills/upload` | Multipart `files` retaining relative filenames, optional `bulk=true`; `?preview=true` returns editable metadata and copied file data. |
| POST | `/api/skills/github` | `{url}` for a public GitHub repository or `/tree/<ref>/<path>`; supports the same preview query. |
| POST | `/api/skills/import` | Saves reviewed names/descriptions and copied files; preflights conflicts and rolls back newly created skills on an import failure. |
| GET/DELETE | `/api/skills/:slug` | Renderable SKILL.md, file list, source and default agents / delete and remove defaults. |
| GET | `/api/machine/skills/:slug/archive?version=<hash>` | Machine bearer auth, JSON `{files:[{path,content}]}` with base64 content. A changed version returns 409 instead of delivering different content. |

Agent turns get `install_skill_from_github {url}`, `create_skill {name,description,instructions}` and `update_skill {slug,description?,instructions?}` over MCP; each call checks the agent's current `createSkills`/`updateSkills` permission and returns a tool error when denied. `create_agent` (master agents only) cannot grant permissions.

`TurnJob.skills` is `{slug,name,description,version}[]`. At claim time the server unions the agent's default skills with exact `@skill-slug` mentions in the task spec and conversation; master agents receive their defaults. The daemon downloads a skill once per hash into `<MUSTER_HOME>/skills-cache/<slug>@<hash>/`, verifies paths, size and hash, writes files through a temporary directory, and appends an `## Available skills` index with absolute SKILL.md paths and the read-before-use rule. Cache files are outside the worktree and are not pruned automatically. Skill changes take effect on subsequent claims.

Skill imports reject absolute/traversing/backslash paths, duplicates, symlinks on server-read folders, non-regular files, more than 200 files and more than 5 MB. GitHub imports inspect the fetched filesystem, reject symlinks and use a temporary shallow sparse clone with disabled prompts/hooks. Ref names containing `/` are not supported in GitHub tree URLs; use a slash-free branch/tag.

## Connections

REST: GET/POST `/api/connections`, GET/PATCH/DELETE `/api/connections/:id`, POST
`/api/connections/:id/test`. Metadata exposes credential **keys**, never values. A
missing `secrets` patch preserves credentials; an explicit object replaces the entire
map, with `{}` clearing it. AES-256-GCM uses `<data dir>/secret.key` (created with mode 0600 by `Vault`) and a fresh IV,
with connection ID and immutable identifier as authenticated binding. Back up that
key and the database together. HTTP credentials are headers; stdio credentials are
environment values. HTTP cannot be machine pinned. The UI requires an online machine
for new stdio connections; the API also allows null to run on any claiming machine.
Existing offline pins remain editable.

Agents grant connections through their profile. Master agents can `list_connections` (read-only,
no credentials), `grant_connection`, and `revoke_connection`. Only master agents can mutate
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
an unavailable approval UI. A granted service may expose
write tools, and local MCP processes run as the daemon OS user. Use appropriately
scoped provider tokens. Claude receives matching entries in `--mcp-config`. Inherited machine CLI configuration and
credentials are not an isolation boundary.

Daemon upload redaction includes connection headers/env and bare Bearer tokens;
connection-bearing jobs redact nonempty short values too. Streaming splits, tool
payloads and completion objects share the same credential set. This is literal
replacement, not encoded-secret detection or scrubbing of runtime files/history.

### Catalog and verified runtime facts

The typed catalog has English/Chinese descriptions and capability bullets, local
monogram/color tiles, and these entries, checked against official sources on
2026-10-25:

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
removed afterwards. Process protocol peers assert exact HTTP/stdio maps and resumed
Codex threads. These checks do not claim live provider
authentication or real model tool execution. Tests use local fixtures and mock turns.
Visual review remains manual; no screenshots or desktop distribution build is used.

## Settings and API keys

`GET/PATCH /api/settings` stores `{workspaceName, notifications}` on the server; `notifications` is `{review, failed, done, dockBadge}` and drives desktop notifications and the Dock badge. Patches reject unknown keys; stored keys from removed settings are ignored. Appearance is a per-device preference in `localStorage`.

GET/POST `/api/api-keys` lists metadata or creates a key; DELETE `/api/api-keys/:id` revokes it. A cryptographically random key is `mst_` plus 32 uniformly sampled base62 characters. SQLite stores SHA256, a ten-character display prefix, name, scopes JSON, creation/last-use/revocation timestamps. Only the creation response contains the full key; the UI shows it once with a copy action. Both `read` and `chief` scopes enable MCP (see [MCP](#mcp)).

Key management and other web REST routes retain Muster's trusted-local-workspace model; API keys secure the external MCP routes, not the whole REST API. Network hosting still requires an authenticated reverse proxy and TLS.

The Settings MCP tab lists the global and every workspace endpoint using the current renderer origin; each workspace's settings page shows its own endpoint with Claude Code, Codex and generic JSON snippets generated by `clientSnippets(url, name)`.

## Agent screenshot artifacts and local images

For project turns the daemon prepares `<MUSTER_HOME>/artifacts/<buildId>/` before
starting the runtime and adds its absolute path and a Markdown example to the
system instructions (including resumed sessions). Agents should save screenshots
there, or copy temporary tool output there before linking it. Directories are
reused across turns of the same build, isolated between builds, and outside Git
checkpoints. Creation errors
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
