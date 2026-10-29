# Muster — 技术方案（MVP）

> Muster 是 [todos.dev](https://todos.dev) 的开源、可自托管实现：一个以「任务（todo）」为中心、人与多个编码 Agent 协作的工作台。
> 你只和一个 **Chief** 对话，它把目标拆成 todos、分派给不同 Agent 并行执行（每个 todo 一个独立 git worktree），在「计划确认」和「变更验收」两个关口停下来等你决策。

## 1. 调研结论（todos.dev 关键机制）

| 概念 | todos.dev 行为 | 当前是否实现 |
|---|---|---|
| Workspace | 左侧 Chief 对话（多 Topic），右侧看板：Backlog / In progress / Needs you / Done(近 7 天)，可拖动分隔条 | ✅ |
| Todo 阶段 | To Do → Queued → Planning → Confirm → Building → Review → Done，另有 Failed / Closed | ✅ |
| 两个关口 | Confirm（计划写完等确认）、Review（diff 完成等验收，Done 时合并回 base 分支） | ✅ |
| Plan first / Run now | 启动时可选先出计划或直接构建 | ✅ |
| Build | 一次执行；分支 `tds/conv-<id>`，独立 worktree，每轮提交 checkpoint | ✅（分支 `muster/conv-<id>`） |
| Plan / Changes 文档 | 右侧面板，版本化（v1, v2…），diff 按文件展示 | ✅（版本化，简化版 diff 视图） |
| Agents | 名字、角色描述、runtime + model、记忆、技能、权限开关 | ✅ 名字/角色/runtime/model、记忆、技能、权限（push 分支、读取 secrets、新建/修改技能） |
| Runtimes | 内置 pi + 20 种外部 CLI（Codex 走 `codex app-server`，Claude Code 走 Agent SDK，多数走 ACP） | ✅ Codex、Claude Code、pi、omp（RPC）、Gemini CLI、OpenCode、Qwen Code、Devin、Cline、dsh、Hermes、OpenClaw、Kiro、Auggie、Qoder、Droid（ACP）；❌ Cursor、Grok Build、Amp、Copilot、Antigravity |
| Machines | `tds start` 守护进程注册机器，按并发上限（默认 6）认领任务 | ✅ `muster-daemon` |
| 中途插话 (steer) | 运行中发送的消息排队，下一个工具调用后注入 | ✅（Codex `turn/steer`；Claude 下轮注入） |
| Chief | 常驻编排会话，通过 MCP 工具读写看板、创建/启动/确认/合并 todo | ✅（单 Topic 起步，结构支持多 Topic） |
| MCP Server | 外部 Agent 通过 MCP 接入同一工作区 | ✅（Chief 复用同一 MCP 端点） |
| Usage | token 用量、时长 | ✅ 基础统计 |
| Teams / 多用户 / 登录 | | ❌（单用户本地，预留 team_id） |
| Schedules | 定时重复任务（按小时/天/周或仅一次），每个周期从标题与描述新建构建 | ✅（时区与夏令时正确处理，错过合并为一次） |
| Skills | 技能库：文件夹/批量上传、公开 GitHub 导入、按内容哈希缓存到各 daemon | ✅ |
| Memory | 每个 agent 的长期记忆，注入后续轮次 | ✅ |
| Connections | 内置目录（Linear、GitHub、Notion、Jira/Confluence、Sentry 等）与自定义 HTTP/stdio MCP 服务 | ✅（OAuth 登录未支持） |
| Secrets | 团队/项目加密 secrets，按权限投放给运行时 shell，输出脱敏 | ✅ |
| AI review / 移动端 / 云机器 / GitHub PR | | ❌ 后续迭代 |

视觉：暗色优先，zinc 色板（`--surface:#18181b` `--surface-secondary:#1f1f23` `--surface-tertiary:#27272a` `--surface-inset:#09090b` `--text-primary:#fafaf9` `--text-secondary:#d4d4d8` `--text-tertiary:#71717a` `--border-default:#27272a` `--border-strong:#3f3f46`），强调色 indigo-400，字体 Inter + JetBrains Mono，Tailwind。极简、高信息密度、圆角小、细边框。

## 2. 技术选型

- **语言**：全栈 TypeScript，Node.js ≥ 22（使用内置 `node:sqlite`，零原生依赖）。
- **包管理**：npm workspaces（monorepo）。
- **apps/server**：Hono + `@hono/node-server`；SQLite（`node:sqlite`）；SSE 推送实时事件；MCP（`@modelcontextprotocol/sdk`，Streamable HTTP，挂在 `/mcp`）。生产模式下同时托管 web 静态资源。
- **apps/web**：Vite + React 19 + TypeScript + Tailwind CSS v4 + TanStack Query + React Router；`react-markdown` + `remark-gfm` 渲染消息/计划；`@dnd-kit` 看板拖拽；`diff2html` 或自写 diff 视图。
- **apps/daemon**：CLI `muster-daemon`（bin），负责注册机器、认领 run、管理 worktree、驱动 runtime、上报事件。
- **packages/shared**：领域类型、zod schema、协议常量（server/daemon/web 共享）。
- **测试**：Vitest；server 用内存 SQLite；daemon 的 git 逻辑用临时仓库测试；runtime 提供 `mock` runtime 便于端到端测试（不调用真实模型）。

## 3. 目录结构

```
Muster/
  package.json            # workspaces, scripts: dev / build / test / lint
  tsconfig.base.json
  packages/shared/src/    # types.ts, schemas.ts, protocol.ts, phases.ts
  apps/server/src/
    index.ts              # 启动入口（PORT 默认 7420，DATA_DIR 默认 ~/.muster）
    db/schema.sql, db/index.ts, db/repo/*.ts
    routes/api.ts         # web 用 REST
    routes/machine.ts     # daemon 用协议
    routes/events.ts      # SSE
    mcp/server.ts         # MCP 工具（Chief + 外部 agent）
    orchestrator/         # 阶段状态机、调度、Chief 会话
  apps/daemon/src/
    index.ts              # muster-daemon start [--server] [--name] [--concurrency]
    client.ts             # 调用 server 的 machine API
    worktree.ts           # base clone / worktree / checkpoint / diff / merge
    runtimes/codex.ts     # codex app-server JSON-RPC
    runtimes/claude.ts    # claude -p --output-format stream-json --input-format stream-json
    runtimes/mock.ts
  apps/web/src/
    pages/Workspace.tsx   # Chief 对话 + 看板
    pages/Todo.tsx        # 单个 todo 对话 + 右侧 Plan/Changes 面板
    pages/Agents.tsx, Projects.tsx, Machines.tsx, Usage.tsx
    components/…
  docs/PLAN.md, docs/ARCHITECTURE.md
```

## 4. 数据模型（SQLite）

```
projects(id, name, repo_url, base_branch, created_at)        -- repo_url 可为本地路径或 git URL
agents(id, name, role, runtime['codex'|'claude'|'mock'], model, reasoning, avatar, is_chief, created_at)
machines(id, name, token, concurrency, runtimes_json, last_seen_at, created_at)
todos(id, number, project_id, title, spec, phase, agent_id, plan_agent_id, mode['plan'|'run'],
      tags_json, created_by['user'|'chief'], created_at, updated_at, done_at)
builds(id /*=conversation id*/, todo_id, branch, machine_id, status, base_commit, head_commit,
       tokens_in, tokens_out, duration_ms, created_at)
turns(id, build_id, kind['plan'|'build'|'revise'|'merge'|'chief'], status['queued'|'running'|'done'|'failed'|'stopped'],
      machine_id, prompt, started_at, ended_at, error, tokens_in, tokens_out)
messages(id, conversation_id /* build id 或 chief topic id */, turn_id, role['user'|'agent'|'system'|'tool'],
         content, meta_json, created_at)
documents(id, build_id, kind['plan'|'changes'], version, content, created_at)  -- changes 存 unified diff
topics(id, title, runtime_session_json, created_at, updated_at)                  -- Chief topics
queued_messages(id, conversation_id, content, delivered_at)
```

## 5. 阶段状态机

```
todo ──start(plan)──▶ queued ─claim─▶ planning ──turn done──▶ confirm
todo ──start(run) ──▶ queued ─claim─▶ building ──turn done──▶ review
confirm ──confirm──▶ queued(build) ─▶ building ─▶ review
confirm/review ──user message──▶ queued(revise) ─▶ planning/building ─▶ 回到同一关口
review ──done(merge=true)──▶ queued(merge) ─▶ (merge turn) ─▶ done（冲突则回 review）
review ──done(merge=false)──▶ done
any running ──error──▶ failed ──rerun(continue|restart)──▶ queued
any ──close──▶ closed ; done/closed ──reopen──▶ 之前的关口
```
Board 映射：Backlog = todo；In progress = queued/planning/building；Needs you = confirm/review/failed；Done = done（近 7 天）。

## 6. Server ⇄ Daemon 协议（HTTP + 长轮询，参考 tds）

所有请求带 `Authorization: Bearer <machine token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/machine/enroll` | `{name, runtimes[], concurrency}` → `{machineId, token}`（MVP：本地免认证；`MUSTER_ENROLL_KEY` 可选） |
| POST | `/api/machine/heartbeat` | `{running:[turnId]}` → `{stop:[turnId]}`，每 5s |
| POST | `/api/machine/claim` | 长轮询 ≤25s，返回 `TurnJob \| null` |
| POST | `/api/machine/turns/:id/events` | 批量上报事件 `AgentEvent[]` |
| GET  | `/api/machine/turns/:id/inbox` | 拉取排队中的用户插话（steer） |
| POST | `/api/machine/turns/:id/complete` | `{status, headCommit, diff?, plan?, usage, error?, sessionState?}` |

`TurnJob`：`{turnId, buildId, todoId, kind, project:{id, repoUrl, baseBranch}, branch, agent:{runtime, model, reasoning, role}, prompt, systemInstructions, sessionState, readOnly, mcp:{url, token}}`

`AgentEvent`（统一事件，web 也消费）：`message.delta | message.completed | reasoning.delta | tool.started | tool.completed | plan.updated | usage | status`。

Daemon 每轮流程：base clone（`~/.muster/workspaces/<projectId>/repo`）→ `git worktree add -b muster/conv-<buildId>`（已存在则复用并对齐）→ 启动 runtime（cwd=worktree）→ 流式上报 → 非只读轮次 `git add -A && git commit` → 计算相对 base 的 diff → complete。Planning 轮为只读：结束后 `git reset --hard && git clean -fd`，计划文本由 agent 写到最终消息（或 `PLAN.md` 输出约定）。Merge 轮：在 base clone 中 `git merge --no-ff muster/conv-<id>`，若 repo_url 为远程则 push。

Runtime 驱动：
- **Codex**：`codex app-server`（stdio JSON-RPC）：`initialize` → `thread/start {cwd, model, developerInstructions, approvalPolicy:'never', sandbox:'danger-full-access', mcp config}`（续轮用 `thread/resume`）→ `turn/start` → 消费 `item/agentMessage/delta`、`item/started|completed`、`turn/completed`；插话用 `turn/steer`，停止用 `turn/interrupt`。若 app-server 协议细节不确定，回退为 `codex exec --json` + `codex exec resume`。
- **Claude Code**：`claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --append-system-prompt … --mcp-config …`，续轮 `--resume <session_id>`。
- **Mock**：确定性地写文件并输出计划，用于测试。

## 7. Chief

- Chief 是 `is_chief=1` 的特殊 agent（默认 runtime=codex），对话不绑定项目、无 worktree，在 daemon 的 `~/.muster/chief/` 目录运行。
- 通过 MCP（`/mcp`，Bearer token）获得工具：`list_projects`、`list_agents`、`list_todos`、`get_todo`、`create_todo`、`start_todo`、`send_todo_message`、`confirm_plan`、`complete_todo`、`close_todo`、`create_agent`。
- 系统提示：只做编排不写代码；拆分任务并行；在关口汇报；用户说"不用问我"则自动确认/合并。
- Todo 状态变化（进入 confirm/review/failed/done）时向 Chief 所在 topic 投递一条 system 通知，并可自动触发 Chief 一轮跟进（可配置，默认开）。

## 8. Web UX（对齐 todos.dev）

- 左侧栏（可折叠，⌘B）：团队名、Search(⌘K)、New task(N)、Workspace（Topics 列表 + New topic）、Agents、Projects、Machines、Usage。
- Workspace：左 Chief 对话，右看板（四列，卡片显示 #编号、标题、项目、agent 头像、阶段点、耗时），分隔条可拖拽，⌘⌥B 切换看板。卡片可拖到 Done / 拖入聊天框作为引用。
- Todo 页：顶部标题 + 阶段徽章 + 主按钮（Confirm / Done / Rerun）；中间对话流（消息、折叠的工具调用终端块、状态条、排队插话托盘）；右侧可切换面板 Plan / Changes（版本选择器、按文件 diff）。
- New task 对话框：项目、标题、描述、agent、Plan first / Run now。
- 实时：SSE `/api/events`，按 conversation/todo 订阅失效 TanStack Query 缓存并追加流式增量。
- 空状态文案与 todos.dev 一致风格（"Nothing waiting to start"等）。

## 9. 里程碑与 Codex 分工

| 阶段 | 内容 | Codex 模型 | 理由 |
|---|---|---|---|
| M0 | 仓库脚手架、本方案、AGENTS.md | Claude（指挥） | — |
| M1 | packages/shared + apps/server（DB、状态机、REST、SSE、machine 协议、MCP）+ 测试 | gpt-5.6-sol · high（已启动，M4 由 gpt-6.1-sol 复核） | 核心架构，正确性要求最高 |
| M2 | apps/daemon（worktree、codex/claude/mock runtime）+ 测试 | gpt-6.1-sol · high | 进程/协议/git 细节多 |
| M3 | apps/web 全部 UI | gpt-6.1-sol · high | 最新主力模型，保证体验还原度 |
| M4 | 端到端联调（mock runtime 全流程 + Chief）、修 bug，复核 M1 | gpt-6.1-sol · high | 跨模块排错 |
| M5 | README、文档、CI（GitHub Actions）、lint 修整 | gpt-6.1-sol · medium | 统一使用最新模型 |
| M6 | Electron 桌面应用：本地 server/daemon、原生集成与打包 | — | macOS 优先，保留 Windows/Linux 构建目标 |

M2、M3 在 M1 完成后并行（目录互不重叠）。每阶段由 Claude 验收（构建、测试、走查）后提交。

## 10. MVP 验收标准

1. `npm install && npm run dev` 启动 server(7420) + web；`npm run daemon` 注册本机。
2. 在 UI 中创建项目（本地 git 仓库路径）、创建 agent（Codex / Claude / Mock）。
3. 新建 todo → Plan first → 看到流式计划 → Confirm → 看到流式构建与 Changes diff → Done 合并到 base 分支。
4. 在 Chief 对话中说"把 X 拆成两个任务并行做"，Chief 通过 MCP 创建并启动 todos，看板实时更新。
5. 多个 todo 并行，各自独立 worktree，互不干扰；中途插话生效。
6. `npm test` 全绿，`npm run build` 成功。
