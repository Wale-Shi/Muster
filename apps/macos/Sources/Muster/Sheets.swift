import SwiftUI
import AppKit

private let specTemplate = "我想要什么：\n\n当前情况：\n\n保留或避免：\n\n如何确认已完成：\n\n期望交付内容："

struct NewTaskSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var projectId: String
  @State private var agentId = ""
  @State private var title = ""
  @State private var spec = ""
  @State private var working = false
  @State private var error: String?
  @FocusState private var titleFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("新建任务").font(.title3.weight(.semibold))
        Spacer()
        Picker("工作空间", selection: $projectId) {
          ForEach(store.projects) { Text($0.name).tag($0.id) }
        }.fixedSize()
      }
      TextField("要完成什么？", text: $title)
        .textFieldStyle(.plain).font(.title3)
        .focused($titleFocused)
      Divider()
      ZStack(alignment: .topLeading) {
        if spec.isEmpty {
          Text(specTemplate).foregroundStyle(.tertiary).padding(.top, 0).padding(.leading, 5).allowsHitTesting(false)
        }
        TextEditor(text: $spec).scrollContentBackground(.hidden).font(.body)
      }
      .frame(minHeight: 200)
      ErrorBanner(message: $error)
      HStack {
        Picker("Agent", selection: $agentId) {
          Text("默认 Agent").tag("")
          ForEach(store.agents.filter { !$0.isChief }) { Text("\($0.name) · \(Runtimes.label($0.runtime))").tag($0.id) }
        }
        .fixedSize()
        if spec.isEmpty { Button("插入模板") { spec = specTemplate }.buttonStyle(.link) }
        Spacer()
        Button("取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button("仅保存") { create(start: false) }.disabled(!valid)
        Button("保存并开始") { create(start: true) }.keyboardShortcut(.return, modifiers: .command).disabled(!valid).buttonStyle(.borderedProminent)
      }
    }
    .padding(20)
    .frame(width: 620)
    .onAppear { titleFocused = true; if store.project(projectId) == nil { projectId = store.projects.first?.id ?? "" } }
  }

  private var valid: Bool { !working && !projectId.isEmpty && !title.trimmingCharacters(in: .whitespaces).isEmpty }

  private func create(start: Bool) {
    guard valid, let api = store.api else { return }
    working = true
    Task {
      do {
        let todo = try await api.createTodo(.init(projectId: projectId, title: title.trimmingCharacters(in: .whitespaces), spec: spec, agentId: agentId.isEmpty ? nil : agentId, start: start))
        store.todos.insert(todo, at: 0)
        store.workspaceId = projectId
        store.route = .task(todo.id)
        dismiss()
      } catch { self.error = error.localizedDescription }
      working = false
    }
  }
}

struct NewWorkspaceSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var repo = ""
  @State private var branch = "main"
  @State private var master = ""
  @State private var working = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("新建工作空间").font(.title3.weight(.semibold))
      Text("一个工作空间对应一个 Git 仓库，仓库需要至少有一次提交。").font(.callout).foregroundStyle(.secondary)
      Form {
        TextField("名称", text: $name, prompt: Text("例如 shop"))
        HStack {
          TextField("仓库", text: $repo, prompt: Text("/path/to/repo 或 https://github.com/…")).font(.body.monospaced())
          Button("选择文件夹…", action: choose)
        }
        TextField("基准分支", text: $branch).font(.body.monospaced())
        Picker("Master agent", selection: $master) {
          Text("默认（\(store.agents.first { $0.isChief }?.name ?? "Chief")）").tag("")
          ForEach(store.agents.filter { !$0.isChief }) { Text("\($0.name) · \(Runtimes.label($0.runtime))").tag($0.id) }
        }
      }
      .formStyle(.columns)
      Text("本地路径需要在运行 Agent 的机器上可访问。Master agent 负责拆分目标、派发和验收这个工作空间的任务。")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      ErrorBanner(message: $error)
      HStack {
        Spacer()
        Button("取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button("创建工作空间", action: create).keyboardShortcut(.defaultAction).disabled(!valid)
      }
    }
    .padding(20)
    .frame(width: 520)
  }

  private var valid: Bool { !working && ![name, repo, branch].contains { $0.trimmingCharacters(in: .whitespaces).isEmpty } }

  private func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
    panel.message = "选择一个 Git 仓库"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    repo = url.path
    if name.isEmpty { name = url.lastPathComponent }
    if let head = try? String(contentsOf: url.appending(path: ".git/HEAD"), encoding: .utf8), head.hasPrefix("ref: refs/heads/") {
      branch = String(head.dropFirst("ref: refs/heads/".count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  private func create() {
    guard valid, let api = store.api else { return }
    working = true
    Task {
      do {
        let project = try await api.createProject(.init(name: name.trimmingCharacters(in: .whitespaces), repoUrl: repo.trimmingCharacters(in: .whitespaces), baseBranch: branch.trimmingCharacters(in: .whitespaces), chiefAgentId: master.isEmpty ? nil : master))
        store.projects.append(project)
        store.workspaceId = project.id
        store.route = .conversation(project.id)
        dismiss()
      } catch { self.error = error.localizedDescription }
      working = false
    }
  }
}

/// ⌘K: jump to any task or workspace by number or title.
struct QuickOpen: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var index = 0
  @FocusState private var focused: Bool

  private struct Item: Identifiable { var id: String; var title: String; var subtitle: String; var phase: Phase?; var route: Route; var workspace: String? }

  private var items: [Item] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "#", with: "")
    let workspaces = store.projects.map { Item(id: "w\($0.id)", title: $0.name, subtitle: "工作空间 · \($0.baseBranch)", phase: nil, route: .conversation($0.id), workspace: $0.id) }
    let tasks = store.todos.filter { $0.phase != .closed }.sorted { ($0.phase.needsYou ? 0 : $0.phase.running ? 1 : 2, -$0.number) < ($1.phase.needsYou ? 0 : $1.phase.running ? 1 : 2, -$1.number) }
      .map { Item(id: $0.id, title: "#\($0.number) \($0.title)", subtitle: "\(store.project($0.projectId)?.name ?? "") · \($0.phase.label)", phase: $0.phase, route: .task($0.id), workspace: $0.projectId) }
    let all = tasks + workspaces
    return Array((q.isEmpty ? all : all.filter { $0.title.lowercased().contains(q) || $0.subtitle.lowercased().contains(q) }).prefix(12))
  }

  var body: some View {
    let items = items
    VStack(spacing: 0) {
      HStack {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("搜索任务或工作空间", text: $query).textFieldStyle(.plain).font(.title3).focused($focused)
          .onSubmit { open(items) }
          .onKeyPress(.downArrow) { index = min(index + 1, items.count - 1); return .handled }
          .onKeyPress(.upArrow) { index = max(index - 1, 0); return .handled }
      }
      .padding(14)
      Divider()
      ScrollView {
        VStack(spacing: 2) {
          ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
            Button { index = i; open(items) } label: {
              HStack(spacing: 10) {
                if let phase = item.phase { PhaseGlyph(phase: phase) } else { Image(systemName: "folder").foregroundStyle(.secondary) }
                VStack(alignment: .leading, spacing: 1) {
                  Text(item.title).lineLimit(1)
                  Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
              }
              .padding(.horizontal, 10).padding(.vertical, 6)
              .background(i == index ? Color.muster.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 6))
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
          if items.isEmpty { Text("没有匹配的结果").foregroundStyle(.secondary).padding(20) }
        }
        .padding(6)
      }
      .frame(height: 360)
    }
    .frame(width: 560)
    .onAppear { focused = true }
    .onChange(of: query) { index = 0 }
  }

  private func open(_ items: [Item]) {
    guard items.indices.contains(index) else { return }
    let item = items[index]
    if let workspace = item.workspace { store.workspaceId = workspace }
    store.route = item.route
    dismiss()
  }
}
