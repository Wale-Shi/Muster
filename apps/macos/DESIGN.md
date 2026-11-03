# Muster for macOS — design notes

The macOS app is a native SwiftUI client. It starts the same Node server and machine daemon the Electron shell used
(`apps/server`, `apps/daemon`) and talks to them over the public HTTP API and SSE stream. The web UI stays for browsers.

## Subject, audience, job

- **Subject**: a workbench where one master agent splits a goal into tasks and coding agents run them in worktrees.
- **Audience**: a developer supervising several agents at once, usually while doing something else.
- **Primary job**: notice what needs a decision (review, failure), make it in a few keystrokes, and otherwise watch
  work happen without clicking into it.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Muster indigo | `#5B5BD6` | `#8B8CF8` | accent, running work, the lead node of the mark |
| Needs-you amber | system orange | system orange | tasks waiting at review |
| Failure | system red | system red | failed tasks, errors |
| Done | system green | system green | merged / done |
| Surfaces | system window / sidebar materials | same | no custom greys: the app follows macOS |

Type: SF Pro for everything people read, SF Mono only for things that are literally code — branches, diffs, session
ids, tool calls and the live activity line. Titles use `.title2` semibold; body 13pt; secondary 11pt.

## Layout

```
┌ Sidebar ───────────────┬ Content ───────────────────────────────┬ Inspector ─────────┐
│ ▾ shop  (workspace)    │ toolbar: name · main   [对话|看板]  ＋  │ (task only)        │
│ 💬 主会话 · Chief   ●  │                                         │ 变更  v2 ▾          │
│ 需要你 2               │  conversation / board / task chat       │ 12 files +210 −40  │
│  ◐ #9  登录页拆分       │                                         │ ▸ src/login.tsx    │
│  ✕ #12 修复测试         │                                         │   diff…            │
│ 进行中 3               │                                         │                    │
│  ◌ #14 搜索接口         │                                         │                    │
│    $ npm test ▍  (live)│                                         │                    │
│ 待开始 · 最近完成       │                                         │                    │
│ ─────                  │                                         │                    │
│ Agent 技能 连接 用量    │                                         │                    │
└────────────────────────┴─────────────────────────────────────────┴────────────────────┘
```

- The sidebar **is the triage queue** (Mail-style), grouped by what you have to do: 需要你 → 进行中 → 待开始 → 最近完成.
  The web version hid this behind a board; on the Mac it is always visible.
- Running rows carry the agent's **live activity line** in mono under the title. This is the one bold element: you can
  watch every agent at once from the sidebar. Everything else stays quiet and system-native.
- A task opens as chat on the left, the diff in a native inspector on the right (⌘⌥I toggles it).
- The workspace view toggles between the master conversation and the board (⌘1 / ⌘2).

## Interaction principles

1. Every action has a menu item and a shortcut: ⌘N new task, ⌘⇧N new workspace, ⌘K quick open, ⌘↩ complete & merge
   at review, ⌘R rerun, ⌘. stop, ⌘⌫ close task, ⌘⌥I inspector, ⌘, settings.
2. The app keeps running when the window closes; a menu bar item shows what needs you and what is running.
3. Notifications are actionable: a review notification opens the task; the Dock badge counts tasks that need you.
4. Errors say what happened and what to do, inline where they happened; nothing apologises.

## Review against the generic default

The first pass copied the web layout (sidebar of links + kanban + chat). That is the generic "SaaS dashboard" shape and
ignores what a Mac does well. Changed: the board became a secondary view, the sidebar became a live triage list, the
diff moved into a real inspector, and custom colours were dropped in favour of system materials so the one accent and
the live line carry the identity.
