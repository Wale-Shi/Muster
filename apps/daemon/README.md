# Muster machine daemon

Node.js 22+, npm workspaces, ESM TypeScript compiled by `tsc`.

```sh
npm install
npm run build --workspace @muster/daemon
npm exec -- muster-daemon start --server http://localhost:7420
```

`start` accepts `--name` (hostname), `--concurrency` (6, range 1–64), and
`--workspaces-dir` (`$MUSTER_HOME/workspaces`). `MUSTER_HOME` defaults to
`~/.muster`. `~` in CLI directory options is expanded. Set `MUSTER_ENROLL_KEY`
when the server requires an enrollment key. Only installed executables on PATH
are advertised for Codex/Claude; mock is always available.

The home directory contains a private `machine.json` registration, a
`running.json` journal, a single-daemon lock, and JSON-lines `daemon.log`.
The same structured logs are written to stdout. Restarting with the same
configuration reuses the token; journaled abandoned turns are reported stopped.
SIGINT/SIGTERM stops accepting work, interrupts model processes, checkpoints
writable work, restores plan work, flushes events, and reports stopped turns.
The pending claim is drained rather than aborted, so shutdown can take one
25-second long-poll interval. Heartbeats continue while work drains. Completion
reporting waits for network recovery rather than abandoning a claimed turn.

## Git behavior

Each project has `<workspaces>/<projectId>/repo`; each build has
`<workspaces>/<buildId>` on `muster/conv-<buildId>`. Existing branches and
worktrees are reused without resetting writable work. Git metadata operations
are serialized per project; different builds execute models concurrently.
Checkpoint commits use `muster: turn <n>`, where the daemon obtains the actual
turn ordinal from M1's todo detail endpoint. Diffs include all build changes
relative to the merge base with the fetched base branch.

Plan turns restore their initial HEAD with `reset --hard` and `clean -fd`,
including when the runtime fails or stops. Merge turns fetch the latest base,
checkout the base branch in the daemon's clone, merge with `--no-ff`, then push.
Conflicts abort the merge and report `{status:"failed", merge:{ok:false,error}}`,
which M1 returns to Review.

For local repositories with the base branch checked out (including linked
worktrees), the daemon refuses a dirty checkout, fetches its merged base into
`refs/muster/incoming/<buildId>` in the origin, then runs `merge --ff-only` there
and removes that temporary ref. It never resets or cleans the user's checkout.
For bare local origins or base branches not checked out, it uses a normal push.
A failed publication restores the daemon's base branch for a retry. Local
relative repository paths are interpreted relative to the daemon's launch cwd.

## Runtime protocols

All adapters implement `start(job, {cwd, emit})`, returning a result promise,
`steer(content)`, and `interrupt()`. Results include text, usage, and resumable
session state. Chief runs in `<home>/chief/<topicId>` without a Git worktree.

Codex's wire contract was inspected using **codex-cli 0.162.1**:

```sh
codex app-server generate-ts --out /private/tmp/muster-m2-codex-protocol
```

Relevant generated types: `InitializeParams`, `ThreadStartParams`,
`ThreadResumeParams`, `TurnStartParams`, `UserInput`, `TurnSteerParams`,
`TurnInterruptParams`, `ThreadItem`, `TurnCompletedNotification`,
`ThreadTokenUsageUpdatedNotification`, and `ThreadTokenUsage`.

- Stdio messages are newline-delimited JSON-RPC envelopes. Send `initialize`
  with `clientInfo` and `capabilities:null`, then an `initialized` notification.
- `thread/start` and `thread/resume` accept cwd, model, developer instructions,
  approval policy, sandbox, and per-thread JSON `config`. Resume uses `threadId`.
  Muster passes `approvalPolicy:"never"`, `workspace-write` for plan turns and
  `danger-full-access` for writable turns. The MCP URL and bearer header are
  passed in `config.mcp_servers.muster.{url,http_headers}` on both start/resume,
  refreshing the per-turn token. No global config is written.
- `turn/start` uses `input:[{type:"text",text,text_elements:[]}]`; reasoning is
  the optional `effort` field. Responses contain `thread.id` or `turn.id`.
- `turn/steer` requires `threadId`, `expectedTurnId`, and input. Interrupt uses
  `threadId` and `turnId`.
- Item notifications carry `item.type`; agent deltas use
  `item/agentMessage/delta`. Reasoning, tool lifecycle, and plan notifications
  map to shared AgentEvents. `turn/completed` has a nested turn whose status is
  `completed`, `interrupted`, or `failed` (not Muster's `done`/`stopped`).
- `thread/tokenUsage/updated` has `tokenUsage.total` and `.last`. Total counters
  are carried in session state and subtracted on resume to avoid double counts;
  `.last` represents one model request rather than the whole Muster turn.

See the [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
and [MCP configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Generated files are inspection artifacts, not a dependency or vendored SDK.

Claude uses the requested stream-json CLI flags plus
`--include-partial-messages` for incremental output. User envelopes are written
to stdin; queued steering waits for subsequent results before the adapter
finishes. `session_id` resumes through `--resume`. MCP is configured through
`--mcp-config` with an HTTP server and bearer header. Runtime processes are
terminated on completion/cancellation, with a bounded force-kill fallback.
Mock streams a deterministic plan or appends the prompt to `MUSTER_MOCK.md`.

## M1 gaps and limits

- Chief jobs have neither `topicId` nor their `chief:<topicId>` branch. The
  daemon emits an empty agent delta, then finds that turn's conversation via
  `/api/topics` and `/api/conversations/:id/messages`. This creates no visible
  message text and selects the correct directory even with multiple topics.
- M1 can claim multiple turns from the same build concurrently. The daemon
  serializes them locally to protect its worktree. Cross-machine serialization
  and refreshing a session captured before a preceding turn finished require a
  server change; queue subsequent turns after completion for reliable resume.
- Events have no idempotency key, and inbox GET marks messages delivered before
  the runtime acknowledges them. Uploads retry transient errors with backoff,
  and inbox messages remain queued locally until the runtime accepts them.
  A lost response can still duplicate event ingestion or lose an inbox batch.
  Exactly-once delivery needs server support.
- Claim/enrollment are not idempotent, so ambiguous requests are not replayed
  inside the HTTP client. A lost claim response (or a crash before journaling
  its ID) cannot be recovered through M1's machine API. Normal graceful shutdown
  avoids introducing this window by draining the pending request. The server
  must eventually expire lost assignments; its current expiry depends on the
  whole machine going offline, not an individual turn lease.

## Validation

```sh
npm run typecheck --workspace @muster/daemon
npm test --workspace @muster/daemon
```

Tests cover temp Git repository lifecycles, origin merge publication and
conflicts, read-only cleanup, mock streaming/steer/interrupt, local protocol
peers for both CLI adapters, retries/batching, registration and restart recovery,
and the real M1 server on a temporary SQLite database over HTTP. Integration
covers plan → confirm → build → merge → done, conflict → Review, concurrent
work, heartbeat stopping, Chief resume, and the compiled CLI's MUSTER_HOME,
logs, and SIGTERM handling. Tests never call a model API.
