import SwiftUI

/// One task: the conversation with its agent, its actions, and the diff in the inspector.
struct TaskView: View {
  @Environment(Store.self) private var store
  var id: String
  @Binding var inspector: Bool
  @State private var completing = false
  @State private var rerunning = false

  var body: some View {
    Group {
      if let detail = store.details[id] {
        content(detail)
      } else if let todo = store.todo(id) {
        ProgressView("正在载入 #\(todo.number)…").frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView("找不到这个任务", systemImage: "questionmark.square.dashed", description: Text("它可能已被删除。"))
      }
    }
    .task(id: id) { await store.loadDetail(id) }
  }

  @ViewBuilder private func content(_ detail: TodoDetail) -> some View {
    let todo = store.todo(id) ?? detail.todo
    let agent = store.agent(todo.agentId)
    let build = detail.builds.last
    ConversationView(
      conversationId: build?.id ?? "",
      todoId: todo.id,
      agentName: agent?.name ?? "Agent",
      runtime: agent?.runtime,
      disabledReason: Self.disabledReason(todo.phase),
      placeholder: todo.phase == .review ? "写下修改意见，Agent 会在同一分支上继续修改…" : "给 \(agent?.name ?? "Agent") 补充说明…",
      initialSpec: todo.spec
    )
    .id(build?.id ?? todo.id)
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 14) {
        Header(todo: todo, detail: detail, agent: agent)
        DecisionCard(todo: todo, detail: detail, agent: agent, inspector: $inspector, complete: { completing = true }, rerun: { rerunning = true })
      }
      .padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 14)
      .frame(maxWidth: 836)
      .frame(maxWidth: .infinity)
      .background(.bar)
    }
    .navigationTitle("#\(todo.number) \(todo.title)")
    .navigationSubtitle(store.project(todo.projectId)?.name ?? "")
    .inspector(isPresented: $inspector) {
      ChangesInspector(detail: detail).inspectorColumnWidth(min: 340, ideal: 540, max: 960)
    }
    .toolbar { actions(todo, detail) }
    .sheet(isPresented: $completing) { CompleteSheet(todo: todo) }
    .confirmationDialog("重新运行 #\(todo.number)", isPresented: $rerunning) {
      Button("继续：保留现有 worktree 和会话") { Task { await store.act(todo, .rerun, ["strategy": .string("continue")]) } }
      Button("从头开始：新建构建和会话") { Task { await store.act(todo, .rerun, ["strategy": .string("restart")]) } }
    } message: { Text("继续上一次的构建，或从任务描述重新开始。") }
    .focusedSceneValue(\.taskCommands, TaskCommands(
      complete: todo.phase == .review ? { completing = true } : nil,
      rerun: todo.phase == .failed ? { rerunning = true } : nil,
      stop: todo.phase.running ? { Task { await store.act(todo, .stop) } } : nil,
      close: [.done, .closed].contains(todo.phase) ? nil : { Task { await store.act(todo, .close) } },
      start: todo.phase == .todo ? { Task { await store.act(todo, .start) } } : nil
    ))
  }

  static func disabledReason(_ phase: Phase) -> String? {
    switch phase {
    case .queued, .building, .review: nil
    case .todo: "开始这个任务后才能对话"
    default: "重新打开或重新运行这个任务以继续"
    }
  }

  @ToolbarContentBuilder private func actions(_ todo: Todo, _ detail: TodoDetail) -> some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      if todo.phase.running {
        let active = ["queued", "running"].contains(detail.builds.last?.turns.last?.status ?? "")
        Button { Task { await store.act(todo, .stop) } } label: { Label("停止", systemImage: "stop.fill") }.disabled(!active).help("请求 Agent 停下（⌘.）")
      }
      Menu {
        if [.done, .closed].contains(todo.phase) { Button("重新打开") { Task { await store.act(todo, .reopen) } } }
        else { Button("关闭任务") { Task { await store.act(todo, .close) } }.keyboardShortcut(.delete) }
        if todo.phase == .failed { Button("重新运行…") { rerunning = true } }
        Divider()
        if let branch = detail.builds.last?.branch { Button("复制分支名") { Clipboard.copy(branch) } }
        Button("复制任务编号") { Clipboard.copy("#\(todo.number)") }
      } label: { Label("更多", systemImage: "ellipsis") }
      .help("更多操作")
      Button { withAnimation(.snappy) { inspector.toggle() } } label: { Label("变更", systemImage: "sidebar.right") }.help("显示或隐藏变更（⌘⌥I）")
    }
  }
}

private struct Header: View {
  var todo: Todo
  var detail: TodoDetail
  var agent: Agent?
  var body: some View {
    let turns = detail.builds.flatMap(\.turns)
    let tokens = detail.builds.reduce(0) { $0 + $1.tokensIn + $1.tokensOut }
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text("#\(todo.number)").font(.system(size: 22, weight: .medium, design: .rounded)).foregroundStyle(.tertiary).monospacedDigit()
        Text(todo.title).font(.system(size: 22, weight: .bold)).lineLimit(2).textSelection(.enabled)
      }
      HStack(spacing: 8) {
        PhaseBadge(phase: todo.phase)
        if let agent {
          MetaPill(systemImage: nil) { AgentAvatar(name: agent.name, size: 15); Text(agent.name) }
            .help("\(Runtimes.label(agent.runtime)) · \(agent.model == "default" ? "CLI 默认模型" : agent.model)")
        }
        if let branch = detail.builds.last?.branch {
          MetaPill(systemImage: "arrow.triangle.branch") { Text(branch).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle) }
            .frame(maxWidth: 260, alignment: .leading)
            .contextMenu { Button("复制分支名") { Clipboard.copy(branch) } }
        }
        Spacer(minLength: 8)
        if tokens > 0 { MetaPill(systemImage: "bolt") { Text(Format.tokens(tokens)).monospacedDigit() }.help("本任务累计 token") }
        RunRecords(turns: turns)
        Text(Format.age(todo.updatedAt)).font(.callout).foregroundStyle(.tertiary)
      }
    }
  }
}

/// The moment the task needs you: what happened, and the one action to take.
private struct DecisionCard: View {
  @Environment(Store.self) private var store
  var todo: Todo
  var detail: TodoDetail
  var agent: Agent?
  @Binding var inspector: Bool
  var complete: () -> Void
  var rerun: () -> Void

  var body: some View {
    let build = detail.builds.last
    let files = build?.documents.filter { $0.kind == "changes" }.max { $0.version < $1.version }.map { Diff.parse($0.content) } ?? []
    let added = files.reduce(0) { $0 + $1.added }, removed = files.reduce(0) { $0 + $1.removed }
    let name = agent?.name ?? "Agent"
    switch todo.phase {
    case .review:
      card(tint: .orange, symbol: "checkmark.seal.fill",
           title: "\(name) 完成了，等你验收",
           detail: Text(files.isEmpty ? "这次构建没有记录 diff" : "\(files.count) 个文件 · ") + Text(files.isEmpty ? "" : "+\(added)").foregroundColor(.green) + Text(files.isEmpty ? "" : " −\(removed)").foregroundColor(.red) + Text(build.map { " · 用时 \(Format.duration($0.durationMs))" } ?? "")) {
        if !inspector { Button { withAnimation(.snappy) { inspector = true } } label: { Text("查看变更") }.secondaryAction().fixedSize() }
        Button(action: complete) { Label("完成并合并", systemImage: "arrow.triangle.merge") }.primaryAction(tint: .orange).fixedSize().keyboardShortcut(.return, modifiers: .command).help("完成并把分支合并到基准分支（⌘↩）")
      }
    case .failed:
      let error = build?.turns.last?.error
      card(tint: .red, symbol: "xmark.octagon.fill", title: "\(name) 没能完成这个任务",
           detail: Text(error.map { String($0.prefix(240)) } ?? "查看下方对话了解失败原因")) {
        Button(action: rerun) { Label("重新运行…", systemImage: "arrow.clockwise") }.primaryAction(tint: .red).fixedSize().keyboardShortcut("r")
      }
    case .todo:
      card(tint: .muster, symbol: "play.circle.fill", title: "这个任务还没开始", detail: Text("开始后 \(name) 会在独立的 worktree 和分支里执行。")) {
        Button { Task { await store.act(todo, .start) } } label: { Label("开始", systemImage: "play.fill") }.primaryAction().fixedSize().keyboardShortcut(.return, modifiers: .command)
      }
    default:
      EmptyView()
    }
  }

  private func card<Actions: View>(tint: Color, symbol: String, title: String, detail: Text, @ViewBuilder actions: () -> Actions) -> some View {
    HStack(spacing: 14) {
      Image(systemName: symbol).font(.system(size: 26)).foregroundStyle(tint).symbolRenderingMode(.hierarchical)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.headline).lineLimit(1).layoutPriority(1)
        detail.font(.callout).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 12)
      HStack(spacing: 8) { actions() }
    }
    .padding(.horizontal, 16).padding(.vertical, 14)
    .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(tint.opacity(0.28)))
    .transition(.move(edge: .top).combined(with: .opacity))
  }
}

/// Every turn with its runtime session, so a run can be resumed or inspected in its CLI.
private struct RunRecords: View {
  var turns: [Turn]
  @State private var open = false
  var body: some View {
    Button { open.toggle() } label: { MetaPill(systemImage: "clock.arrow.circlepath") { Text("\(turns.count) 轮") } }
      .buttonStyle(.plain)
      .popover(isPresented: $open, arrowEdge: .bottom) {
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            Text("执行记录").font(.headline)
            if turns.isEmpty { Text("还没有执行过").foregroundStyle(.secondary) }
            ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
              VStack(alignment: .leading, spacing: 3) {
                HStack {
                  Text("第 \(index + 1) 轮").fontWeight(.semibold)
                  Text(Self.kind(turn.kind)).foregroundStyle(.secondary)
                  Text(Self.status(turn.status)).foregroundStyle(turn.status == "failed" ? .red : .secondary)
                  Spacer()
                  if let started = turn.startedAt { Text(Format.time(started)).foregroundStyle(.tertiary) }
                }
                if let agent = turn.agent {
                  Text("\(agent.name) · \(Runtimes.label(agent.runtime)) · \(agent.model == "default" ? "CLI 默认模型" : agent.model)").foregroundStyle(.secondary)
                }
                if let error = turn.error { Text(error).foregroundStyle(.red).lineLimit(4).textSelection(.enabled) }
                if let session = turn.sessionId {
                  HStack {
                    Text(session).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    Button { Clipboard.copy(session) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).help("复制会话 ID")
                  }
                }
              }
              .font(.callout)
            }
            if turns.contains(where: { $0.sessionId != nil }) {
              Text("会话 ID 可以在对应 CLI 里恢复或查看这一轮。").font(.caption).foregroundStyle(.secondary)
            }
          }
          .padding(16)
        }
        .frame(width: 420).frame(maxHeight: 480)
      }
  }
  static func kind(_ kind: String) -> String { ["build": "构建", "revise": "修改", "merge": "合并", "chief": "主会话"][kind] ?? kind }
  static func status(_ status: String) -> String { ["queued": "排队中", "running": "运行中", "done": "完成", "failed": "失败", "stopped": "已停止"][status] ?? status }
}

/// Finish a task at review, merging its branch by default.
struct CompleteSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var todo: Todo
  @State private var merge = true
  @State private var working = false
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("完成 #\(todo.number)").font(.title3.weight(.semibold))
      Text(todo.title).foregroundStyle(.secondary)
      Toggle("把改动合并到基准分支", isOn: $merge)
      Text(merge ? "执行机会合并这次构建；合并成功前任务保持在进行中。" : "任务会直接完成，分支保留但不合并。")
        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if let error = store.lastError { Text(error).font(.callout).foregroundStyle(.red) }
      HStack {
        Spacer()
        Button("取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button(merge ? "完成并合并" : "完成") {
          working = true
          Task {
            await store.act(todo, .done, ["merge": .bool(merge)])
            working = false
            if store.lastError == nil { dismiss() }
          }
        }
        .keyboardShortcut(.defaultAction).disabled(working)
      }
    }
    .padding(20).frame(width: 420)
  }
}

struct TaskCommands {
  var complete: (() -> Void)?
  var rerun: (() -> Void)?
  var stop: (() -> Void)?
  var close: (() -> Void)?
  var start: (() -> Void)?
}

struct TaskCommandsKey: FocusedValueKey { typealias Value = TaskCommands }
extension FocusedValues {
  var taskCommands: TaskCommands? { get { self[TaskCommandsKey.self] } set { self[TaskCommandsKey.self] = newValue } }
}
