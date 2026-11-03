import SwiftUI

struct RootView: View {
  @Environment(Store.self) private var store
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var store = store
    @Bindable var app = app
    Group {
      if let error = store.startupError {
        ContentUnavailableView {
          Label("Muster 没有启动", systemImage: "exclamationmark.octagon")
        } description: { Text(error).textSelection(.enabled) } actions: {
          Button("显示日志") { NSWorkspace.shared.activateFileViewerSelecting([app.backend.logs]) }
          Button("重试") { app.launch() }.keyboardShortcut(.defaultAction)
        }
      } else if store.api == nil || (!store.connected && store.projects.isEmpty) {
        VStack(spacing: 14) {
          MusterMark(size: 44)
          ProgressView().controlSize(.small)
          Text(store.api == nil ? "正在启动 Muster…" : "正在连接服务…").foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        NavigationSplitView {
          SidebarView(selection: $store.route, newWorkspace: { app.sheet = .workspace }, newTask: { app.sheet = .task })
        } detail: {
          Detail(inspector: $app.inspector)
        }
      }
    }
    .frame(minWidth: 900, minHeight: 600)
    .sheet(item: $app.sheet) { sheet in
      switch sheet {
      case .task: NewTaskSheet(projectId: store.workspace?.id ?? "")
      case .workspace: NewWorkspaceSheet()
      case .quickOpen: QuickOpen()
      }
    }
    .onChange(of: store.route) { _, route in
      // Following a task elsewhere switches the sidebar to its workspace.
      if case .task(let id) = route, let todo = store.todo(id), todo.projectId != store.workspaceId { store.workspaceId = todo.projectId }
    }
    .onChange(of: store.projects) {
      if store.route == nil, let project = store.workspace { store.route = .conversation(project.id) }
    }
  }
}

private struct Detail: View {
  @Environment(Store.self) private var store
  @Environment(AppModel.self) private var app
  @Binding var inspector: Bool
  var body: some View {
    @Bindable var store = store
    VStack(spacing: 0) {
      if let error = store.lastError {
        ErrorBanner(message: $store.lastError).padding(.horizontal, 16).padding(.top, 8)
          .task(id: error) { try? await Task.sleep(for: .seconds(12)); if store.lastError == error { store.lastError = nil } }
      }
      switch store.route {
      case .conversation(let id): if let project = store.project(id) { MasterConversation(project: project) } else { missing }
      case .board(let id): if let project = store.project(id) { BoardView(project: project) { app.sheet = .task } } else { missing }
      case .task(let id): TaskView(id: id, inspector: $inspector)
      case .workspaceSettings(let id): WorkspaceSettingsView(id: id)
      case .agents: AgentsView()
      case .agent(let id): AgentDetailView(id: id)
      case .skills: SkillsView()
      case .connections: ConnectionsView()
      case .usage: UsageView()
      case nil:
        ContentUnavailableView {
          Label("从一个工作空间开始", systemImage: "folder.badge.plus")
        } description: { Text("一个工作空间对应一个 Git 仓库，并有自己的 master agent。") } actions: {
          Button("新建工作空间") { app.sheet = .workspace }.keyboardShortcut(.defaultAction)
        }
      }
    }
    .frame(minWidth: 480)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button { app.sheet = .task } label: { Label("新建任务", systemImage: "square.and.pencil") }.help("新建任务（⌘N）").disabled(store.projects.isEmpty)
      }
    }
  }
  private var missing: some View { ContentUnavailableView("找不到这个工作空间", systemImage: "folder.badge.questionmark") }
}

private struct MasterConversation: View {
  @Environment(Store.self) private var store
  var project: Project
  var body: some View {
    let master = store.master(of: project)
    ConversationView(
      conversationId: project.topicId,
      agentName: master?.name ?? "Chief",
      runtime: master?.runtime,
      placeholder: "告诉 \(master?.name ?? "Chief") 你的目标…",
      suggestions: ["把这个目标拆成可以并行的任务：", "汇报一下各任务的进展和卡点", "验收所有待验收的任务，没问题就合并"]
    )
    .id(project.topicId)
    .navigationTitle(project.name)
    .navigationSubtitle("主会话 · \(master?.name ?? "Chief")")
    .task(id: project.topicId) { await store.loadTopic(project.topicId) }
  }
}
