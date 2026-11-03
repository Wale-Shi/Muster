import Foundation
import Observation

enum Route: Hashable {
  case conversation(String)
  case board(String)
  case task(String)
  case workspaceSettings(String)
  case agents
  case agent(String)
  case skills
  case connections
  case usage
}

/// What a conversation's agent is doing right now.
struct Activity: Equatable {
  var status = "idle" // idle | queued | running
  var detail = ""
  var warning: String?
  var unread = false
  var turns: Set<String> = []
}

/// The latest line an agent produced, for watching work from the sidebar.
struct LiveLine: Equatable { var text: String; var tool: Bool; var at: Date }

@MainActor @Observable
final class Store {
  var api: API?
  var connected = false
  var startupError: String?
  var projects: [Project] = []
  var todos: [Todo] = []
  var agents: [Agent] = []
  var machines: [Machine] = []
  var details: [String: TodoDetail] = [:]
  var messages: [String: [Message]] = [:]
  var queued: [String: [QueuedMessage]] = [:]
  var activity: [String: Activity] = [:]
  var live: [String: LiveLine] = [:]
  var settings: WorkspaceSettings?
  var route: Route?
  var lastError: String?
  var machineId: String?
  /// A task phase change worth telling the person about.
  @ObservationIgnored var onPhase: ((Todo, Phase) -> Void)?
  @ObservationIgnored private var stream: EventStream?
  @ObservationIgnored private var refreshing: Set<String> = []

  var workspaceId: String? {
    didSet { UserDefaults.standard.set(workspaceId, forKey: "workspace") }
  }

  init() { workspaceId = UserDefaults.standard.string(forKey: "workspace") }

  var workspace: Project? { projects.first { $0.id == workspaceId } ?? projects.first }
  func master(of project: Project?) -> Agent? {
    agents.first { $0.id == project?.chiefAgentId } ?? agents.first { $0.isChief }
  }
  func agent(_ id: String?) -> Agent? { agents.first { $0.id == id } }
  func project(_ id: String?) -> Project? { projects.first { $0.id == id } }
  func todo(_ id: String) -> Todo? { todos.first { $0.id == id } ?? details[id]?.todo }
  var needsYouCount: Int { settings?.notifications.dockBadge == false ? 0 : todos.filter { $0.phase.needsYou }.count }
  var onlineMachines: [Machine] { machines.filter { $0.online == true } }

  func tasks(in project: String?) -> [Todo] { todos.filter { $0.projectId == project } }

  // MARK: Connection

  func connect(_ origin: URL) {
    api = API(origin: origin)
    let stream = EventStream(origin: origin)
    self.stream = stream
    stream.start(onState: { [weak self] connected in
      guard let self else { return }
      let changed = self.connected != connected
      self.connected = connected
      if connected && changed { Task { await self.refreshAll() } }
    }, onEvent: { [weak self] event in self?.handle(event) })
    Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(10))
        await self.load("machines") { self.machines = try await $0.machines() }
      }
    }
  }

  func refreshAll() async {
    async let p: Void = load("projects") { self.projects = try await $0.projects() }
    async let t: Void = load("todos") { self.todos = try await $0.todos() }
    async let a: Void = load("agents") { self.agents = try await $0.agents() }
    async let m: Void = load("machines") { self.machines = try await $0.machines() }
    async let s: Void = load("settings") { self.settings = try await $0.settings() }
    _ = await (p, t, a, m, s)
    if workspaceId == nil || project(workspaceId) == nil { workspaceId = projects.first?.id }
    for conversation in messages.keys { await loadMessages(conversation) }
    for id in details.keys { await loadDetail(id) }
    for project in projects { await loadTopic(project.topicId) }
  }

  /// Runs one fetch at a time per key; reports failures without clearing what is shown.
  func load(_ key: String, _ body: @escaping @MainActor (API) async throws -> Void) async {
    guard let api, !refreshing.contains(key) else { return }
    refreshing.insert(key); defer { refreshing.remove(key) }
    do { try await body(api) } catch is CancellationError {} catch { if connected { lastError = error.localizedDescription } }
  }

  func loadMessages(_ conversation: String) async {
    guard !conversation.isEmpty else { return }
    await load("messages:\(conversation)") { api in
      let snapshot = try await api.messages(conversation)
      // Keep streamed revisions newer than the snapshot.
      var merged = snapshot
      for message in self.messages[conversation] ?? [] {
        if let i = merged.firstIndex(where: { $0.id == message.id }) { if message.revision > merged[i].revision { merged[i] = message } }
        else if !snapshot.isEmpty, message.createdAt > (snapshot.last?.createdAt ?? "") { merged.append(message) }
      }
      self.messages[conversation] = merged
      self.queued[conversation] = try await api.queued(conversation)
    }
  }

  func loadDetail(_ id: String) async {
    await load("todo:\(id)") { self.details[id] = try await $0.todo(id) }
  }

  func loadTopic(_ id: String) async {
    await load("topic:\(id)") { api in
      let topic = try await api.topic(id)
      var current = self.activity[id] ?? Activity()
      if current.turns.isEmpty { current.status = topic.activity }
      self.activity[id] = current
    }
  }

  // MARK: Events

  func handle(_ event: ServerEvent) {
    let type = event.type
    if type == "sync.reset" { Task { await refreshAll() }; return }
    if let todoId = event.todoId, let line = Self.liveLine(event) { live[todoId] = LiveLine(text: line.text, tool: line.tool, at: Date()) }
    if let conversation = event.conversationId {
      apply(event, to: conversation)
      track(event, in: conversation)
    }
    if type.hasPrefix("todo.") {
      if let id = event.todoId { Task { await loadDetail(id) } }
      let previous = event.todoId.flatMap { todo($0)?.phase }
      Task {
        await load("todos") { self.todos = try await $0.todos() }
        if let id = event.todoId, let todo = self.todo(id), let phase = event.payload?["phase"]?.string.flatMap(Phase.init) ?? Optional(todo.phase), phase != previous {
          self.onPhase?(todo, phase)
        }
      }
    }
    if type.hasPrefix("turn."), let id = event.todoId { Task { await loadDetail(id); await load("todos") { self.todos = try await $0.todos() } } }
    if type.hasPrefix("project.") { Task { await load("projects") { self.projects = try await $0.projects() } } }
    if type.hasPrefix("agent.") { Task { await load("agents") { self.agents = try await $0.agents() } } }
    if type.hasPrefix("machine.") || type == "turn.completed" { Task { await load("machines") { self.machines = try await $0.machines() } } }
    if type == "document.created", let id = event.todoId { Task { await loadDetail(id) } }
    if let conversation = event.conversationId, ["message.queued", "message.delivered", "message.queue_changed", "turn.completed"].contains(type) {
      Task { await load("queued:\(conversation)") { self.queued[conversation] = try await $0.queued(conversation) } }
    }
  }

  nonisolated static func liveLine(_ event: ServerEvent) -> (text: String, tool: Bool)? {
    if event.type == "tool.started", let tool = event.payload?["tool"]?.string { return (tool, true) }
    if event.type == "message.delta" || event.type == "message.completed", let content = event.message?.content {
      let line = content.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
      return line.map { (String($0.suffix(160)), false) }
    }
    return nil
  }

  /// Every update carries the whole message with an increasing revision, so replays never duplicate text.
  private func apply(_ event: ServerEvent, to conversation: String) {
    guard messages[conversation] != nil else { return }
    if event.type == "message.deleted", let id = event.payload?["id"]?.string { messages[conversation]?.removeAll { $0.id == id }; return }
    var incoming = event.message
    if incoming == nil, event.type == "message.created", let payload = event.payload,
       let data = try? JSONEncoder().encode(payload) { incoming = try? JSONDecoder().decode(Message.self, from: data) }
    guard let incoming else {
      if event.type == "turn.completed" { Task { await loadMessages(conversation) } }
      return
    }
    if let i = messages[conversation]!.firstIndex(where: { $0.id == incoming.id }) {
      if incoming.revision >= messages[conversation]![i].revision { messages[conversation]![i] = incoming }
    } else { messages[conversation]!.append(incoming) }
    if event.type == "message.completed" || event.type == "turn.completed" { Task { await loadMessages(conversation) } }
  }

  private func track(_ event: ServerEvent, in conversation: String) {
    var current = activity[conversation] ?? Activity()
    let type = event.type
    if type.hasPrefix("turn."), let turn = event.payload?["turnId"]?.string {
      if type == "turn.completed" { current.turns.remove(turn) } else { current.turns.insert(turn) }
    }
    switch type {
    case "turn.queued": current.status = "queued"
    case "turn.started": current.status = "running"; current.detail = ""
    case "turn.completed": if current.turns.isEmpty { current.status = "idle" }; current.detail = ""
    case "status": current.detail = event.payload?["detail"]?.string ?? current.detail
    case "warning": current.warning = event.payload?["detail"]?.string
    case "message.created": if event.payload?["role"]?.string != "user" { current.unread = true }
    case "message.delta", "reasoning.delta", "message.completed", "tool.started", "tool.completed":
      current.detail = ""; current.warning = nil
    default: break
    }
    activity[conversation] = current
  }

  // MARK: Actions

  /// Runs an action and turns any failure into an inline error.
  @discardableResult
  func perform(_ body: (API) async throws -> Void) async -> Bool {
    guard let api else { return false }
    do { try await body(api); lastError = nil; return true }
    catch { lastError = error.localizedDescription; return false }
  }

  func act(_ todo: Todo, _ action: API.Action, _ input: [String: JSONValue] = [:]) async {
    if await perform({ try await $0.act(todo.id, action, input) }) {
      await load("todos") { self.todos = try await $0.todos() }
      await loadDetail(todo.id)
    }
  }
}
