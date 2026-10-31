# Muster — 产品规格

> Muster 是一个可自托管的多 Agent 编码工作台。核心只有一条主线：**设置好工作空间 → master agent 在工作空间里拆分、分派并跟进任务 → 每个任务的执行过程都可观测 → 其他 AI 可以通过 MCP 给 master agent 派活。**
>
> 实现细节与接口契约见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 范围

保留并重点打磨：

| 能力 | 说明 |
|---|---|
| 工作空间 | 一个工作空间对应一个 Git 仓库（本地路径或 Git URL）与基准分支。可以有任意多个工作空间。 |
| Master agent | 每个工作空间可以指定不同的 master agent；未指定时使用默认 master agent（初始的 `Chief`）。任何 Agent 都可以担任 master agent。 |
| 主对话 | 每个工作空间有且只有一个与其 master agent 的主对话，创建工作空间时自动生成。 |
| 任务 | master agent（或用户、其他 AI）创建任务；任务一创建即可直接执行（无计划/确认关口），在独立 worktree 与分支 `muster/conv-<buildId>` 中运行。 |
| 跟进与验收 | 任务进入「待验收」或「失败」时，自动通知所在工作空间的 master agent；它检查 diff 后合并（`complete_task`）或打回修改（`send_task_message`），必要时再问用户。 |
| 可观测 | 任务页实时展示 Agent 的输出、推理、工具调用、插话队列和每个版本的 diff；看板卡片显示运行中任务的最新一行输出或工具调用；同样的数据可经 MCP（`get_task`、`get_task_log`）读取。 |
| MCP 开放 | `/api/mcp`（全部工作空间）与 `/api/mcp/workspaces/:id`（单个工作空间）用 API 密钥鉴权；其他 AI 可用 `assign_work` 把目标交给 master agent，或直接 `create_task`，并观察进展。 |
| Skills | 技能库：文件夹/批量上传、公开 GitHub 导入，按内容哈希缓存到 daemon，Agent 可设默认技能、用 `@slug` 引用。 |
| Connections | 内置目录（Linear、GitHub、Notion、Playwright）与自定义 HTTP/stdio MCP 服务，凭据加密、只写；在 Agent 资料页授权。 |
| 基础设施 | 16 种编码 CLI 运行时、本机执行器（daemon，不在界面中出现）、桌面 App（macOS 优先）。所有 Agent 都在当前电脑上运行，暂不考虑跨机器。 |

已移除（2026-10-30 做减法）：Plan first / Confirm 关口、定时任务、Secrets、Agent 记忆、附件、标签、用量统计页、项目文件/提交浏览、多话题、命令面板与快捷键表、机器管理页和界面上的「机器」概念、推送分支权限、英文界面（界面仅中文）。

## 2. 数据模型（SQLite，节选）

```
projects(id, name, repo_url, base_branch, description, chief_agent_id → agents, created_at)   -- 工作空间
topics(id, title, project_id UNIQUE → projects, runtime_session_json, ...)                      -- 工作空间主对话
agents(id, name, role, runtime, model, reasoning, is_chief, permissions_json, default_skill_ids_json, connection_ids_json, ...)
todos(id, number, project_id, title, spec, phase, agent_id, created_by['user'|'chief'], topic_id, previous_gate, ...)
builds(id, todo_id NULL 表示 master agent 对话, branch 'muster/conv-<id>' 或 'chief:<topicId>', machine_id, status, ...)
turns(id, build_id, kind['build'|'revise'|'merge'|'chief'], status, prompt, agent_snapshot_json, not_before, ...)
messages(id, conversation_id /* build id 或 topic id */, turn_id, role['user'|'agent'|'system'|'tool'], content, meta_json, ...)
documents(id, build_id, kind['changes'], version, content)          -- 每次构建/修订的 unified diff
skills, connections, settings, api_keys, machines, queued_messages, mcp_tokens, event_batches, machine_claims, server_events
```

## 3. 任务状态机

```
todo ──start──▶ queued ─claim─▶ building ──turn done──▶ review（待验收）
review ──反馈──▶ queued(revise) ─▶ building ─▶ review
review ──done(merge=true)──▶ queued(merge) ─▶ done（冲突则回 review）
review ──done(merge=false)──▶ done
running ──error/stop──▶ failed ──rerun(continue|restart)──▶ queued
any ──close──▶ closed ; done/closed ──reopen──▶ review 或 todo
```

看板四列：待办 = todo；进行中 = queued/building；待你处理 = review/failed；已完成 = done（近 7 天）。

## 4. Master agent

- 运行在 daemon 的 `~/.muster/chief/<topicId>`，不进入仓库 worktree；系统提示包含工作空间名称、ID、仓库、基准分支、说明，以及所选 Agent 的职责描述。
- 职责：只编排不写代码；把目标拆成可并行的任务并分派；跟进每个任务；待验收时对照 spec 检查 diff，合格就合并，不合格就给出具体修改意见；失败时读日志后重跑或上报。用户要求亲自验收、改动有风险或不确定时先问用户。
- 自动跟进：任务进入 review/failed 时向工作空间主对话写入系统通知，并在 3 秒防抖后合并为一轮 master agent 跟进（`MUSTER_CHIEF_AUTO_FOLLOW_UP=false` 可关闭）；进入 done 只记录通知。
- MCP 工具默认作用于自己的工作空间，并且不能操作其他工作空间。

## 5. 开放给其他 AI 的 MCP

| 工具 | 说明 |
|---|---|
| `list_workspaces` / `get_workspace` | 工作空间、master agent、任务列表与各阶段数量 |
| `list_tasks` / `get_task` / `get_task_log` | 任务、执行轮次、最新 diff、执行日志 |
| `read_master_conversation` | 读取与 master agent 的最近对话 |
| `assign_work` | 把目标交给 master agent，由它拆分、执行、验收 |
| `create_task` / `start_task` / `send_task_message` / `complete_task` / `rerun_task` / `stop_task` / `close_task` | 直接管理任务（需要 `chief` 权限的密钥） |

`read` 密钥只能使用只读工具。工作空间地址把所有工具限定在该工作空间内。

## 6. 验收标准

1. `npm install && npm run dev` 启动 server(7420) + web；`npm run daemon` 注册本机。
2. 新建两个工作空间，分别指定不同的 master agent；在各自主对话里提出目标，master agent 通过 MCP 创建并启动任务，看板实时更新。
3. 任务执行时，看板卡片与任务页实时显示 Agent 输出和工具调用；完成后显示 diff，master agent 自动跟进验收并合并到基准分支。
4. 用 API 密钥把工作空间 MCP 地址接入另一个 AI，`assign_work` 后能通过 `get_workspace`、`get_task_log` 观察进展。
5. 多个任务并行，各自独立 worktree，互不干扰；中途插话生效。
6. `npm run typecheck && npm test`、`npm run build`、`npm run e2e` 全部通过。
