# Muster

Muster 是一个开源、可自托管的多 Agent 编码工作台，只做一件事：

1. **设置工作空间**：一个工作空间对应一个 Git 仓库。可以建很多个工作空间。
2. **每个工作空间有自己的 master agent**：在工作空间的主对话里把目标交给它，它把目标拆成可并行的任务，分派给编码 Agent，并一路跟进到验收合并。不同工作空间可以用不同的 master agent。
3. **每个任务的执行过程都可观测**：任务在独立的 Git worktree 和分支里运行，Agent 的输出、推理、工具调用、插话和每个版本的 diff 都实时可见；看板卡片直接显示运行中任务的最新动作。
4. **开放 master agent 的 MCP**：其他 AI（Claude Code、Codex、Cursor……）用 API 密钥接入工作空间的 MCP 地址，就能给 master agent 派活，并观察任务进展。

此外保留 **Skills**（技能库）和 **Connections**（MCP 连接）。界面为中文。

## 快速开始

需要 Node.js 22+（见 [.nvmrc](.nvmrc)）、npm 和 Git。在仓库根目录运行：

```sh
npm install
npm run dev
```

另开一个终端：

```sh
npm run daemon
```

打开 <http://localhost:5173>（API 在 7420 端口，Vite 会代理 API、SSE 和 MCP）。

1. **新建工作空间**：填写本地 Git 仓库路径（或 Git URL）和基准分支，选择它的 master agent（不选则用默认的 `Chief`）。仓库需要至少有一次提交。
2. **在「Agent」里创建编码 Agent**：选择运行时和模型。对应 CLI 需要安装在本机（见下文）；Agent 列表会标出本机未安装的运行时。
3. **在工作空间对话里告诉 master agent 目标**，例如“把登录页拆成可并行的任务”。它会创建并启动任务，在任务待验收或失败时自动跟进，检查 diff 后合并或打回修改。
4. 也可以直接 **新建任务**（⌘Enter 保存并启动），点开任务查看实时执行过程；在待验收时写下修改意见，或点「完成」合并回基准分支。

不想调用模型的话，可以把 master agent 和编码 Agent 都设为 `mock` 运行时，然后对 master agent 发送 `/split 试试 Muster`。Mock 会在 `MUSTER_MOCK.md` 里写入确定性的改动，不会调用任何模型 API。

## 让其他 AI 给工作空间派活

1. 在 **设置 → API 密钥** 创建一个密钥：`chief` 权限可以派活和管理任务，`read` 只能查看。完整密钥只显示一次。
2. 在 **工作空间设置** 复制这个工作空间的 MCP 地址 `http://localhost:7420/api/mcp/workspaces/<id>`（它只能访问本工作空间，工具默认作用于它）。全局地址 `/api/mcp` 可访问所有工作空间，调用时传 `workspaceId`。
3. 在另一个 AI 里添加 MCP 服务器，例如 Claude Code：

```sh
claude mcp add --transport http muster-shop http://localhost:7420/api/mcp/workspaces/<id> --header "Authorization: Bearer <key>"
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.muster_shop]
url = "http://localhost:7420/api/mcp/workspaces/<id>"
http_headers = { Authorization = "Bearer <key>" }
```

通用 MCP JSON（Cursor 等）：

```json
{ "mcpServers": { "muster-shop": { "url": "http://localhost:7420/api/mcp/workspaces/<id>", "headers": { "Authorization": "Bearer <key>" } } } }
```

主要工具：

| 工具 | 作用 |
| --- | --- |
| `assign_work` | 把目标交给 master agent，由它拆分、执行、验收 |
| `get_workspace` / `list_tasks` | 查看 master agent、全部任务及其阶段 |
| `get_task` / `get_task_log` | 查看任务的执行轮次、最新 diff 和执行日志 |
| `read_master_conversation` | 读取 master agent 的最新回复 |
| `create_task` / `send_task_message` / `complete_task` / `rerun_task` / `close_task` | 直接管理任务 |

完整列表和权限见 [架构文档](docs/ARCHITECTURE.md#mcp)。

## 生产模式

```sh
npm install
npm run build && npm start
```

打开 <http://localhost:7420>，server 同时提供界面和 API。另外用 `npm run daemon`（或进程管理器）运行 daemon。请持久化 server 数据目录和 daemon 的 home 目录。

## 安全模型

REST API 没有登录：能访问端口的人就能使用整个 Muster。它面向可信机器上的单个用户。为了挡住其他网站，server 只接受 `Host` 为回环地址、`MUSTER_PUBLIC_URL` 的主机名或 `MUSTER_ALLOWED_HOSTS` 中主机名的请求，并拒绝带外部 `Origin` 或 `Sec-Fetch-Site: cross-site` 的写请求——这能防住恶意网页和 DNS 重绑定，但不是身份认证。机器请求使用每台机器的 token，`/api/mcp` 需要 API 密钥，可选的 enrollment key 只保护机器注册。Agent 在 Git worktree 里以完全访问/跳过审批模式运行，所以只把 Muster 指向你信任的仓库、CLI 和凭据。漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。远程部署请放在带认证的反向代理和 TLS 后面。

## 桌面 App

在 macOS 上可以把整个本地工作台打包成一个 App：

```sh
npm install
npm run desktop:dev
# 为本机架构构建 ad-hoc 签名的 Muster.app 和 DMG：
npm run desktop:dist
# 可选：用 mock 回合在隐藏窗口中检查打包后的 App：
npm run desktop:smoke
```

产物在 `apps/desktop/release/`。App 内置 Electron 的 Node、server、daemon 和界面，不需要系统 Node；Git 和各 Agent CLI 需要另行安装并登录。请把 App 安装在 `/Applications` 或 `~/Applications`。数据在 `~/.muster`，日志在 `~/.muster/logs`。App 会在任务待验收、失败、完成时发送通知（可在设置里开关），并在程序坞显示需要你处理的任务数。

## 配置

环境变量需要在进程环境中设置，Muster 不会自动读取 `.env`。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | server 绑定地址 |
| `PORT` | `7420` | server 端口（Vite 开发代理指向 7420） |
| `MUSTER_DATA_DIR` | `~/.muster` | server 数据目录（`muster.db`、技能、加密密钥） |
| `MUSTER_PUBLIC_URL` | `http://127.0.0.1:<port>` | 用于生成 MCP 地址，daemon 必须能访问；其主机名会被允许 |
| `MUSTER_ALLOWED_HOSTS` | 未设置 | 额外允许的 `Host` 主机名（逗号分隔） |
| `MUSTER_ENROLL_KEY` | 未设置 | 可选的执行器注册密钥，server 与 daemon 设置相同值 |
| `MUSTER_CLAIM_WAIT_MS` | `25000` | 认领任务的长轮询时长 |
| `MUSTER_CHIEF_AUTO_FOLLOW_UP` | `true` | 设为 `false` 后 master agent 不再自动跟进任务通知 |
| `MUSTER_HOME` | `~/.muster` | daemon 的注册信息、日志、master agent 会话和 worktree |

daemon 选项包括 `--server`、`--name`、`--concurrency`（默认 6，范围 1–64）和 `--workspaces-dir`：

```sh
npm run daemon -- --concurrency 2 --name laptop
```

## 运行时

Muster 的所有 Agent 都在本机运行：后台执行器（daemon，桌面 App 会自动启动）负责调用各 CLI。用当前用户安装并登录需要的 CLI，然后重启 Muster。它会在 `PATH` 和常见安装目录（`~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.opencode/bin`、`~/.kiro/bin`、`/opt/homebrew/bin`、`/usr/local/bin`）中查找；找不到时用 `MUSTER_<ID>_BIN`（如 `MUSTER_PI_BIN`）指定。`mock` 始终可用。Muster 复用各 CLI 自己的登录，不管理模型服务商的凭据。

| 运行时 (id) | 安装 | 驱动方式 |
| --- | --- | --- |
| Codex (`codex`) | `npm i -g @openai/codex` | `codex app-server` |
| Claude Code (`claude`) | [claude.com/claude-code](https://claude.com/claude-code) | `claude -p` stream-json |
| pi (`pi`) | `npm i -g @mariozechner/pi-coding-agent` | `pi --mode rpc` |
| omp (`omp`) | `curl -fsSL https://omp.sh/install \| sh` | `omp --mode rpc` |
| Gemini CLI (`gemini`) | `npm i -g @google/gemini-cli` | `gemini --acp` |
| OpenCode (`opencode`) | `curl -fsSL https://opencode.ai/install \| bash` | `opencode acp` |
| Qwen Code (`qwen`) | `npm i -g @qwen-code/qwen-code` | `qwen --acp` |
| Devin (`devin`) | `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin acp` |
| Cline (`cline`) | `npm i -g cline` | `cline --acp` |
| dsh (`dsh`) | `npm i -g @deepseek-ai/dsh` | `dsh --profile acp` |
| Hermes Agent (`hermes`) | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | `hermes acp` |
| OpenClaw (`openclaw`) | `npm i -g openclaw`，并保持其 Gateway 运行 | `openclaw acp` |
| Kiro CLI (`kiro`) | `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli acp` |
| Auggie (`auggie`) | `npm i -g @augmentcode/auggie` | `auggie --acp` |
| Qoder CLI (`qoder`) | `npm i -g @qoder-ai/qodercli`（也识别国内版 `qoderclicn`） | `qodercli --acp` |
| Droid (`droid`) | `curl -fsSL https://app.factory.ai/cli \| sh` | `droid exec --output-format acp` |

所有回合都以可写模式运行（Codex `danger-full-access`、Claude `bypassPermissions`、ACP 选择最宽松的模式），Muster 的 MCP 工具与授权的 Connections 会注入每个回合。模型选 `default` 时由 CLI 使用自己配置的模型。各运行时的协议细节和已验证版本见 [架构文档](docs/ARCHITECTURE.md#runtime-integration-and-remaining-limits) 与 [daemon 说明](apps/daemon/README.md)。

## 架构

```mermaid
flowchart LR
  User[用户] --> Web[Web / 桌面 App]
  Web <-->|REST + SSE| Server[Hono server]
  Server --> DB[(SQLite)]
  Daemon[本机执行器 daemon] <-->|认领 / 心跳 / 事件| Server
  Daemon --> Master[各工作空间的 master agent]
  Daemon --> Agents[并行的编码 Agent]
  Agents --> Trees[独立 Git worktree]
  Master --> Runtimes[Codex / Claude Code / pi / ACP CLI / Mock]
  Agents --> Runtimes
  Runtimes <-->|MCP 回合令牌| MCP[/mcp]
  Partner[其他 AI] <-->|MCP + API 密钥| ExtMCP[/api/mcp/workspaces/:id]
  MCP --> Server
  ExtMCP --> Server
```

`packages/shared` 定义领域类型和协议；`apps/server` 负责持久化与编排；`apps/daemon` 管理 worktree 和运行时；`apps/web` 是界面；`apps/desktop` 是 Electron 外壳。产品规格见 [docs/PLAN.md](docs/PLAN.md)，接口契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)，copyright 2026 Wale Shi.
