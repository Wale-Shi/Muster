import SwiftUI

/// The sidebar is the triage queue: the master conversation, then tasks by what you have to do about them.
struct SidebarView: View {
  @Environment(Store.self) private var store
  @Binding var selection: Route?
  var newWorkspace: () -> Void
  var newTask: () -> Void
  @State private var showDone = false

  var body: some View {
    let project = store.workspace
    let tasks = store.tasks(in: project?.id)
    let needsYou = tasks.filter { $0.phase.needsYou }.sorted { ($0.phase == .failed ? 0 : 1, -$0.number) < ($1.phase == .failed ? 0 : 1, -$1.number) }
    let running = tasks.filter { $0.phase.running }.sorted { $0.number > $1.number }
    let backlog = tasks.filter { $0.phase == .todo }.sorted { $0.number > $1.number }
    let weekAgo = Date().addingTimeInterval(-7 * 86_400)
    let done = tasks.filter { $0.phase == .done && (Dates.parse($0.doneAt) ?? .distantPast) > weekAgo }.sorted { ($0.doneAt ?? "") > ($1.doneAt ?? "") }

    List(selection: $selection) {
      if let project {
        let master = store.master(of: project)
        let activity = store.activity[project.topicId] ?? Activity()
        NavigationLink(value: Route.conversation(project.id)) {
          Label {
            HStack {
              Text("主会话")
              Spacer()
              if activity.status != "idle" { ProgressView().controlSize(.mini) }
              else if activity.unread { Circle().fill(Color.muster).frame(width: 7, height: 7).accessibilityLabel("有新回复") }
              else { Text(master?.name ?? "Chief").font(.caption).foregroundStyle(.tertiary) }
            }
          } icon: { Image(systemName: "bubble.left.and.text.bubble.right") }
        }
        NavigationLink(value: Route.board(project.id)) {
          Label("看板", systemImage: "square.grid.3x1.below.line.grid.1x2")
        }
        .badge(tasks.filter { $0.phase != .closed }.count)

        if !needsYou.isEmpty {
          Section { ForEach(needsYou) { TaskRow(todo: $0) } } header: { SectionTitle(title: "需要你", count: needsYou.count, tint: .orange) }
        }
        Section {
          ForEach(running) { TaskRow(todo: $0) }
          if running.isEmpty { Text("没有正在执行的任务").font(.callout).foregroundStyle(.tertiary) }
        } header: { SectionTitle(title: "进行中", count: running.count, tint: .muster) }
        if !backlog.isEmpty {
          Section { ForEach(backlog) { TaskRow(todo: $0) } } header: { SectionTitle(title: "待开始", count: backlog.count, tint: .secondary) }
        }
        if !done.isEmpty {
          Section(isExpanded: $showDone) { ForEach(done) { TaskRow(todo: $0) } } header: { SectionTitle(title: "最近完成", count: done.count, tint: .secondary) }
        }
      } else if store.connected {
        ContentUnavailableView {
          Label("还没有工作空间", systemImage: "folder.badge.plus")
        } description: { Text("一个工作空间对应一个 Git 仓库。") } actions: { Button("新建工作空间", action: newWorkspace) }
      }

      Section("管理") {
        NavigationLink(value: Route.agents) { Label("Agent", systemImage: "person.2") }
        NavigationLink(value: Route.skills) { Label("技能", systemImage: "book.closed") }
        NavigationLink(value: Route.connections) { Label("连接", systemImage: "point.3.connected.trianglepath.dotted") }
        NavigationLink(value: Route.usage) { Label("用量", systemImage: "chart.bar") }
      }
    }
    .listStyle(.sidebar)
    .safeAreaInset(edge: .top, spacing: 0) { WorkspacePicker(newWorkspace: newWorkspace).padding(.horizontal, 10).padding(.top, 2).padding(.bottom, 8) }
    .safeAreaInset(edge: .bottom, spacing: 0) { ConnectionFooter() }
    .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 380)
  }
}

private struct SectionTitle: View {
  var title: String
  var count: Int
  var tint: Color
  var body: some View {
    HStack(spacing: 6) {
      Text(title)
      Text("\(count)").monospacedDigit().foregroundStyle(tint)
    }
  }
}

/// A task in the sidebar. Running tasks show the agent's latest line, so every agent can be watched at once.
struct TaskRow: View {
  @Environment(Store.self) private var store
  var todo: Todo
  private var subtitle: String {
    let agent = store.agent(todo.agentId)?.name
    let head = ["#\(todo.number)", agent].compactMap { $0 }.joined(separator: " · ")
    switch todo.phase {
    case .review: return "\(head) · 等你验收"
    case .failed: return "\(head) · 失败"
    case .queued: return "\(head) · 等待执行机"
    default: return "\(head) · \(Format.age(todo.updatedAt))"
    }
  }
  var body: some View {
    let live = todo.phase.running ? store.live[todo.id] : nil
    NavigationLink(value: Route.task(todo.id)) {
      HStack(alignment: .top, spacing: 8) {
        PhaseGlyph(phase: todo.phase).font(.system(size: 13)).frame(width: 16).padding(.top, 1)
        VStack(alignment: .leading, spacing: 2) {
          Text(todo.title).lineLimit(1)
          if let live {
            HStack(spacing: 4) {
              Image(systemName: live.tool ? "terminal" : "text.bubble").imageScale(.small)
              Text(live.text).lineLimit(1).truncationMode(.tail)
            }
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(Color.muster)
            .contentTransition(.opacity)
            .animation(.easeOut(duration: 0.2), value: live.text)
          } else {
            Text(subtitle).font(.caption).foregroundStyle(todo.phase.needsYou ? AnyShapeStyle(todo.phase.color) : AnyShapeStyle(.tertiary)).lineLimit(1)
          }
        }
      }
      .padding(.vertical, 2)
    }
    .help("#\(todo.number) \(todo.title) · \(todo.phase.label)")
    .contextMenu { TaskMenu(todo: todo) }
  }
}

struct TaskMenu: View {
  @Environment(Store.self) private var store
  var todo: Todo
  var body: some View {
    if todo.phase == .todo { Button("开始") { Task { await store.act(todo, .start) } } }
    if todo.phase.running { Button("停止") { Task { await store.act(todo, .stop) } } }
    if [.done, .closed].contains(todo.phase) { Button("重新打开") { Task { await store.act(todo, .reopen) } } }
    else { Button("关闭任务") { Task { await store.act(todo, .close) } } }
    Divider()
    Button("复制任务编号") { Clipboard.copy("#\(todo.number)") }
  }
}

private struct WorkspacePicker: View {
  @Environment(Store.self) private var store
  var newWorkspace: () -> Void
  var body: some View {
    Menu {
      ForEach(store.projects) { project in
        Button {
          store.workspaceId = project.id
          store.route = .conversation(project.id)
        } label: {
          if project.id == store.workspace?.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
        }
      }
      Divider()
      if let project = store.workspace { Button("工作空间设置…") { store.route = .workspaceSettings(project.id) } }
      Button("新建工作空间…", action: newWorkspace)
    } label: {
      HStack(spacing: 10) {
        if let project = store.workspace {
          AgentAvatar(name: project.name, size: 28)
          VStack(alignment: .leading, spacing: 1) {
            Text(project.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            HStack(spacing: 3) {
              Image(systemName: "arrow.triangle.branch").imageScale(.small)
              Text(project.baseBranch).font(.caption.monospaced())
            }
            .foregroundStyle(.secondary)
          }
        } else {
          MusterMark(size: 22); Text("Muster").font(.headline)
        }
        Spacer(minLength: 4)
        Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 8).padding(.vertical, 7)
      .contentShape(RoundedRectangle(cornerRadius: 10))
      .glassSurface(cornerRadius: 12, interactive: true)
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .help("切换工作空间")
  }
}

private struct ConnectionFooter: View {
  @Environment(Store.self) private var store
  var body: some View {
    let online = store.onlineMachines.count
    let running = store.machines.reduce(0) { $0 + ($1.running ?? 0) }
    let (color, text): (Color, String) = !store.connected ? (.orange, "正在连接服务…")
      : online == 0 ? (.orange, "没有在线的执行机")
      : (.green, running > 0 ? "执行机在线 · \(running) 个运行中" : "执行机在线")
    HStack(spacing: 7) {
      Circle().fill(color).frame(width: 7, height: 7)
        .shadow(color: color.opacity(0.7), radius: 3)
      Text(text).font(.caption).foregroundStyle(.secondary)
      Spacer()
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .glassSurface(cornerRadius: 10)
    .padding(.horizontal, 10).padding(.bottom, 10)
    .help(store.machines.map { "\($0.name)：\($0.online == true ? "在线" : "离线")" }.joined(separator: "\n"))
  }
}
