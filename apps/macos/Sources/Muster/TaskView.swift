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
    VStack(spacing: 0) {
      Header(todo: todo, detail: detail, agent: agent, project: store.project(todo.projectId))
      Divider()
      ConversationView(
        conversationId: build?.id ?? "",
        todoId: todo.id,
        agentName: agent?.name ?? "Agent",
        runtime: agent?.runtime,
        disabledReason: Self.disabledReason(todo.phase),
        placeholder: todo.phase == .review ? "写下修改意见，Agent 会在同一分支上继续修改" : "给 Agent 发送补充说明",
        initialSpec: todo.spec
      )
      .id(build?.id ?? todo.id)
    }
    .navigationTitle("#\(todo.number) \(todo.title)")
    .navigationSubtitle(store.project(todo.projectId)?.name ?? "")
    .inspector(isPresented: $inspector) {
      ChangesInspector(detail: detail).inspectorColumnWidth(min: 320, ideal: 520, max: 900)
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
      switch todo.phase {
      case .todo:
        Button { Task { await store.act(todo, .start) } } label: { Label("开始", systemImage: "play.fill") }.help("开始执行（⌘↩）")
      case .review:
        Button { completing = true } label: { Label("完成", systemImage: "checkmark.circle") }.help("完成并合并（⌘↩）")
      case .failed:
        Button { rerunning = true } label: { Label("重新运行", systemImage: "arrow.clockwise") }.help("重新运行（⌘R）")
      case .queued, .building:
        let active = ["queued", "running"].contains(detail.builds.last?.turns.last?.status ?? "")
        Button { Task { await store.act(todo, .stop) } } label: { Label("停止", systemImage: "stop.fill") }.disabled(!active).help("请求 Agent 停下（⌘.）")
      case .done, .closed:
        Button { Task { await store.act(todo, .reopen) } } label: { Label("重新打开", systemImage: "arrow.uturn.backward") }
      }
      if ![.done, .closed].contains(todo.phase) {
        Button { Task { await store.act(todo, .close) } } label: { Label("关闭任务", systemImage: "xmark.circle") }.help("关闭任务（⌘⌫）")
      }
      Button { inspector.toggle() } label: { Label("变更", systemImage: "sidebar.right") }.help("显示或隐藏变更（⌘⌥I）")
    }
  }
}

private struct Header: View {
  var todo: Todo
  var detail: TodoDetail
  var agent: Agent?
  var project: Project?
  var body: some View {
    let turns = detail.builds.flatMap(\.turns)
    let tokens = detail.builds.reduce(0) { $0 + $1.tokensIn + $1.tokensOut }
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("#\(todo.number)").font(.title3.monospacedDigit()).foregroundStyle(.tertiary)
        Text(todo.title).font(.title3.weight(.semibold)).lineLimit(2).textSelection(.enabled)
      }
      HStack(spacing: 12) {
        PhaseBadge(phase: todo.phase)
        if let agent {
          HStack(spacing: 5) { Monogram(name: agent.name, size: 16); Text(agent.name) }
            .help("\(Runtimes.label(agent.runtime)) · \(agent.model == "default" ? "CLI 默认模型" : agent.model)")
        }
        if let branch = detail.builds.last?.branch {
          Label(branch, systemImage: "arrow.triangle.branch").font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
            .contextMenu { Button("复制分支名") { Clipboard.copy(branch) } }
        }
        Spacer()
        Text(Format.age(todo.updatedAt)).foregroundStyle(.tertiary)
        if tokens > 0 { Label(Format.tokens(tokens), systemImage: "circle.hexagongrid").help("本任务累计用量") }
        RunRecords(turns: turns)
      }
      .font(.callout)
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20).padding(.vertical, 12)
  }
}

/// Every turn with its runtime session, so a run can be resumed or inspected in its CLI.
private struct RunRecords: View {
  var turns: [Turn]
  @State private var open = false
  var body: some View {
    Button { open.toggle() } label: { Label("\(turns.count) 轮", systemImage: "clock.arrow.circlepath") }
      .buttonStyle(.borderless)
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
