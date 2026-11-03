import SwiftUI
import AppKit

/// `Muster --snapshot <dir>` renders the main screens with sample data to PNGs, without a server, then quits.
/// Used to review the interface where nobody can look at the screen.
@MainActor
enum Snapshots {
  static let requested = CommandLine.arguments.contains("--snapshot")
  private static var windows: [NSWindow] = []

  static func run() {
    let args = CommandLine.arguments
    let dir = URL(fileURLWithPath: args.firstIndex(of: "--snapshot").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? NSTemporaryDirectory())
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let store = AppModel.shared.store
    seed(store)
    let model = AppModel.shared
    model.inspector = true
    let shots: [(String, Route, NSAppearance.Name)] = [
      ("conversation-dark", .conversation("p1"), .darkAqua),
      ("conversation-light", .conversation("p1"), .aqua),
      ("task-dark", .task("t3"), .darkAqua),
      ("task-light", .task("t3"), .aqua),
      ("board-dark", .board("p1"), .darkAqua),
      ("agents-light", .agents, .aqua),
      ("failed-dark", .task("t4"), .darkAqua),
    ]
    Task {
      for (name, route, appearance) in shots {
        store.route = route
        let window = NSWindow(contentRect: NSRect(x: -4000, y: 200, width: 1360, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: RootView().environment(store).environment(model))
        window.setFrameOrigin(NSPoint(x: -4000, y: 200))
        window.orderFront(nil)
        windows.append(window)
        try? await Task.sleep(for: .seconds(1.5))
        guard let frame = window.contentView?.superview else { continue }
        if let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) {
          frame.cacheDisplay(in: frame.bounds, to: rep)
          try? rep.representation(using: .png, properties: [:])?.write(to: dir.appending(path: "\(name).png"))
        }
        window.orderOut(nil)
      }
      print("Snapshots written to \(dir.path)")
      exit(0)
    }
  }

  private static func iso(_ minutesAgo: Double) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date().addingTimeInterval(-minutesAgo * 60))
  }

  static func seed(_ store: Store) {
    store.offline = true
    store.api = API(origin: URL(string: "http://127.0.0.1:9")!)
    store.connected = true
    store.settings = WorkspaceSettings(workspaceName: "Muster", notifications: NotificationPreferences())
    store.projects = [
      Project(id: "p1", name: "shop", repoUrl: "/Users/me/code/shop", baseBranch: "main", chiefAgentId: nil, topicId: "topic1", description: nil, createdAt: iso(9000)),
      Project(id: "p2", name: "docs-site", repoUrl: "/Users/me/code/docs", baseBranch: "main", chiefAgentId: nil, topicId: "topic2", description: nil, createdAt: iso(9000)),
    ]
    store.workspaceId = "p1"
    store.agents = [
      Agent(id: "chief", name: "Chief", role: "拆分目标、派发任务、验收合并", runtime: "claude", model: "default", reasoning: nil, isChief: true, permissions: nil, defaultSkillIds: nil, connectionIds: nil, createdAt: iso(9000)),
      Agent(id: "a1", name: "Atlas", role: "前端组件与交互，React + TypeScript", runtime: "codex", model: "gpt-6.1-sol", reasoning: "high", isChief: false, permissions: nil, defaultSkillIds: nil, connectionIds: nil, createdAt: iso(9000)),
      Agent(id: "a2", name: "Forge", role: "后端接口、数据库迁移和测试", runtime: "claude", model: "claude-opus-5-5", reasoning: nil, isChief: false, permissions: nil, defaultSkillIds: nil, connectionIds: nil, createdAt: iso(9000)),
    ]
    store.machines = [Machine(id: "m1", name: "Mac-mini.local", concurrency: 6, runtimes: ["codex", "claude", "mock"], models: nil, lastSeenAt: iso(0), online: true, running: 2)]
    func todo(_ id: String, _ n: Int, _ title: String, _ phase: Phase, _ agent: String, _ ago: Double, done: Bool = false) -> Todo {
      Todo(id: id, number: n, projectId: "p1", title: title, spec: "", phase: phase, agentId: agent, createdBy: "chief", createdAt: iso(ago + 30), updatedAt: iso(ago), doneAt: done ? iso(ago) : nil)
    }
    store.todos = [
      todo("t1", 14, "搜索接口加分页和游标", .building, "a2", 2),
      todo("t2", 13, "购物车价格计算改为整数分", .building, "a1", 4),
      { var t = todo("t3", 12, "登录页拆分成独立组件", .review, "a1", 11); t.spec = "把登录页拆成**表单**、**第三方登录**、**状态 hook** 三部分，保持现有行为和测试不变。"; return t }(),
      todo("t4", 11, "修复结算页在 Safari 下的布局", .failed, "a1", 25),
      todo("t5", 10, "订单列表支持导出 CSV", .todo, "a2", 60),
      todo("t6", 9, "升级 React Router 到 v7", .queued, "a1", 1),
      todo("t7", 8, "商品详情页图片懒加载", .done, "a1", 300, done: true),
      todo("t8", 7, "给支付回调加幂等键", .done, "a2", 900, done: true),
    ]
    store.live = [
      "t1": LiveLine(text: "npm test -- search.spec.ts", tool: true, at: Date()),
      "t2": LiveLine(text: "把 price 字段的类型从 number 换成 Cents，并更新调用方…", tool: false, at: Date()),
    ]
    store.activity["topic1"] = Activity(status: "running", detail: "", warning: nil, unread: false, turns: ["x"])
    func msg(_ id: String, _ conv: String, _ role: String, _ content: String, _ ago: Double, _ meta: [String: JSONValue] = [:]) -> Message {
      Message(id: id, conversationId: conv, turnId: nil, role: role, content: content, meta: meta, createdAt: iso(ago))
    }
    store.messages["topic1"] = [
      msg("m1", "topic1", "user", "把结算流程的几个问题拆一下并行做：价格精度、Safari 布局、支付回调幂等。", 40),
      msg("m2", "topic1", "tool", "", 39, ["type": .string("tool.started"), "tool": .string("list_tasks"), "input": .object(["workspaceId": .string("p1")])]),
      msg("m3", "topic1", "tool", "", 39, ["type": .string("tool.started"), "tool": .string("create_task"), "input": .object(["title": .string("购物车价格计算改为整数分")])]),
      msg("m4", "topic1", "agent", "已拆成 3 个任务并分派：\n\n1. **#13 购物车价格计算改为整数分** → Atlas\n2. **#11 修复结算页在 Safari 下的布局** → Atlas\n3. **#7 给支付回调加幂等键** → Forge（已完成并合并）\n\n#11 第一次构建失败了，原因是 `vite build` 找不到 `postcss.config.cjs`。我会让 Atlas 修好后重跑。", 30),
      msg("m5", "topic1", "system", "", 11, ["phase": .string("review"), "todoId": .string("t3"), "todoNumber": .number(12), "todoTitle": .string("登录页拆分成独立组件")]),
      msg("m6", "topic1", "user", "#12 看起来不错，帮我验收一下", 8),
      msg("m7", "topic1", "agent", "正在检查 #12 的 diff：拆出了 `LoginForm`、`OAuthButtons` 和 `useLoginState` 三个模块，测试", 1, ["streaming": .bool(true)]),
    ]
    store.messages["b3"] = [
      msg("k1", "b3", "agent", "我先看一下现有的登录页结构。", 20),
      msg("k2", "b3", "tool", "", 19, ["type": .string("tool.started"), "tool": .string("Read"), "input": .object(["file_path": .string("src/pages/Login.tsx")])]),
      msg("k3", "b3", "tool", "", 19, ["type": .string("tool.started"), "tool": .string("Bash"), "input": .object(["command": .string("npm test -- login")])]),
      msg("k4", "b3", "agent", "拆分完成：\n\n- `LoginForm.tsx`：表单与校验\n- `OAuthButtons.tsx`：第三方登录按钮\n- `useLoginState.ts`：状态与提交逻辑\n\n```ts\nexport function useLoginState() {\n  const [email, setEmail] = useState(\"\")\n  return { email, setEmail }\n}\n```\n\n所有测试通过（12 passed）。", 12),
    ]
    let diff = """
    diff --git a/src/pages/Login.tsx b/src/pages/Login.tsx
    --- a/src/pages/Login.tsx
    +++ b/src/pages/Login.tsx
    @@ -1,14 +1,8 @@
    -import { useState } from "react"
    +import { LoginForm } from "../components/LoginForm"
    +import { OAuthButtons } from "../components/OAuthButtons"

     export function Login() {
    -  const [email, setEmail] = useState("")
    -  const [password, setPassword] = useState("")
    -  return <form>
    -    <input value={email} onChange={(e) => setEmail(e.target.value)} />
    -  </form>
    +  return <main><LoginForm /><OAuthButtons /></main>
     }
    diff --git a/src/hooks/useLoginState.ts b/src/hooks/useLoginState.ts
    --- /dev/null
    +++ b/src/hooks/useLoginState.ts
    @@ -0,0 +1,5 @@
    +export function useLoginState() {
    +  const [email, setEmail] = useState("")
    +  const [password, setPassword] = useState("")
    +  return { email, setEmail, password, setPassword }
    +}
    """
    let detailJSON = """
    {"id":"t3","number":12,"projectId":"p1","title":"登录页拆分成独立组件","spec":"把登录页拆成表单、第三方登录、状态 hook 三部分，保持现有行为不变。","phase":"review","agentId":"a1","createdBy":"chief","createdAt":"\(iso(40))","updatedAt":"\(iso(11))","doneAt":null,
     "builds":[{"id":"b3","branch":"muster/12-login-split","status":"active","tokensIn":182000,"tokensOut":24000,"durationMs":412000,
       "turns":[{"id":"u1","kind":"build","status":"done","startedAt":"\(iso(20))","endedAt":"\(iso(12))","error":null,"tokensIn":182000,"tokensOut":24000,"sessionId":"019a-3f2c-thread","agent":{"name":"Atlas","runtime":"codex","model":"gpt-6.1-sol"}}],
       "documents":[{"id":"d1","buildId":"b3","kind":"changes","version":1,"content":\(String(decoding: try! JSONEncoder().encode(diff), as: UTF8.self)),"createdAt":"\(iso(12))"}]}]}
    """
    store.details["t3"] = try? JSONDecoder().decode(TodoDetail.self, from: Data(detailJSON.utf8))
    let failedJSON = """
    {"id":"t4","number":11,"projectId":"p1","title":"修复结算页在 Safari 下的布局","spec":"Safari 17 下结算按钮被挤出视口。","phase":"failed","agentId":"a1","createdBy":"chief","createdAt":"\(iso(60))","updatedAt":"\(iso(25))","doneAt":null,
     "builds":[{"id":"b4","branch":"muster/11-safari-checkout","status":"failed","tokensIn":40000,"tokensOut":3000,"durationMs":95000,
       "turns":[{"id":"u4","kind":"build","status":"failed","startedAt":"\(iso(30))","endedAt":"\(iso(25))","error":"vite build failed: Cannot find module 'postcss.config.cjs'","tokensIn":40000,"tokensOut":3000,"sessionId":null,"agent":{"name":"Atlas","runtime":"codex","model":"gpt-6.1-sol"}}],"documents":[]}]}
    """
    store.details["t4"] = try? JSONDecoder().decode(TodoDetail.self, from: Data(failedJSON.utf8))
    store.messages["b4"] = [msg("f1", "b4", "agent", "构建失败：`vite build` 找不到 `postcss.config.cjs`。可能是配置文件被重命名成了 `.mjs`。", 25)]
  }
}
