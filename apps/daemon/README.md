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
when the server requires an enrollment key. Only runtimes whose executable is
found (PATH, common install directories, or `MUSTER_<ID>_BIN`) are advertised;
mock is always available. See the root README for the runtime list.

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
turn ordinal from the shared todo detail endpoint. Diffs include all build changes
relative to the merge base with the fetched base branch.

Plan turns restore their initial HEAD with `reset --hard` and `clean -fd`,
including when the runtime fails or stops. Merge turns fetch the latest base,
checkout the base branch in the daemon's clone, merge with `--no-ff`, then push.
Conflicts abort the merge and report `{status:"failed", merge:{ok:false,error}}`,
which the server returns to Review.

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
  Muster passes `approvalPolicy:"never"`, `read-only` for plan turns and
  `danger-full-access` for writable turns. The MCP URL and bearer header are
  passed in `config.mcp_servers.muster.{url,required:true,http_headers}` on both start/resume,
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
Claude refreshes instructions on resume with `--system-prompt-snapshot off`, uses plan permission mode for read-only turns, and forwards reasoning via `--effort`. Mock streams a deterministic plan or appends the prompt to `MUSTER_MOCK.md`. A mock Chief `/split <goal>` calls authenticated MCP to create and start two todos.

## Integrated protocol (M4)

Chief jobs provide `topicId` directly. The server serializes each build/topic across machines and selects fresh resume state only at claim time, using immutable agent/model snapshots. Builds remain pinned to their worktree machine; restarting a failed build creates a fresh branch that another machine can claim.

Claims use `requestId`, event batches use `batchId`, and completion retries are idempotent. Inbox GET reserves messages without consuming them; the daemon ACKs after runtime acceptance and retains accepted IDs while retrying an ACK. A machine/turn heartbeat lease recovers lost assignments within 30 seconds. Final event uploads drain before completion reporting, including after transient network outages.

Exactly-once steer injection across a process crash is not guaranteed: a crash between runtime acceptance and server ACK can redeliver feedback. Enrollment remains non-idempotent and is not retried after ambiguous failures. See [architecture](../../docs/ARCHITECTURE.md) for schemas and limits. Real model APIs are never called by tests.

## Validation

```sh
npm run typecheck --workspace @muster/daemon
npm test --workspace @muster/daemon
```

Tests cover temp Git repository lifecycles, origin merge publication and
conflicts, read-only cleanup, mock streaming/steer/interrupt, local protocol
peers for both CLI adapters, retries/batching, registration and restart recovery,
and the real Muster server on a temporary SQLite database over HTTP. Integration
covers plan → confirm → build → merge → done, conflict → Review, concurrent
work, heartbeat stopping, Chief resume, and the compiled CLI's MUSTER_HOME,
logs, and SIGTERM handling. Tests never call a model API.
