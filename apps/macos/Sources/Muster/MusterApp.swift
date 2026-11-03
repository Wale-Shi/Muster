import SwiftUI
import AppKit
import UserNotifications

enum SheetKind: String, Identifiable { case task, workspace, quickOpen; var id: String { rawValue } }

/// Owns the backend processes and the store for the app's lifetime.
@MainActor @Observable
final class AppModel {
  /// One per process: SwiftUI may evaluate the App's initial values more than once, and each model starts a backend.
  static let shared = AppModel()
  let store = Store()
  @ObservationIgnored let backend = Backend()
  var sheet: SheetKind?
  var inspector = true
  @ObservationIgnored var openMain: (() -> Void)?
  @ObservationIgnored private var badgeTask: Task<Void, Never>?

  private init() {
    store.onPhase = { [weak self] todo, phase in self?.notify(todo, phase) }
    backend.onWorkerExit = { [weak self] name, code in
      self?.store.startupError = "\(name == "server" ? "服务" : "执行机 daemon")意外退出（退出码 \(code)）。详见 \(self?.backend.logs.appending(path: "\(name).log").path ?? "日志")。"
    }
    if Snapshots.requested { return }
    launch()
    badgeTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        let count = self.store.needsYouCount
        NSApp?.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
        self.store.machineId = self.backend.machineId
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  func launch() {
    store.startupError = nil
    Task {
      do {
        try await backend.start()
        store.connect(backend.origin)
      } catch {
        backend.log("Startup failed: \(error)")
        store.startupError = error.localizedDescription
      }
    }
  }

  static var canNotify: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }

  func notify(_ todo: Todo, _ phase: Phase) {
    guard Self.canNotify, let settings = store.settings?.notifications else { return }
    let wanted = phase == .review ? settings.review : phase == .failed ? settings.failed : phase == .done ? settings.done : false
    guard wanted else { return }
    let content = UNMutableNotificationContent()
    content.title = phase == .review ? "任务等待验收" : phase == .failed ? "任务失败" : "任务已完成"
    content.subtitle = store.project(todo.projectId)?.name ?? ""
    content.body = "#\(todo.number) \(todo.title)"
    content.userInfo = ["todoId": todo.id]
    content.categoryIdentifier = phase == .review ? "review" : "task"
    content.sound = phase == .failed ? .default : nil
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "\(todo.id)-\(phase.rawValue)", content: content, trigger: nil))
  }

  func open(todo id: String) {
    if let todo = store.todo(id) { store.workspaceId = todo.projectId }
    store.route = .task(id)
    openMain?()
    NSApp.activate(ignoringOtherApps: true)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  @MainActor var model: AppModel { AppModel.shared }

  private var signals: [DispatchSourceSignal] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    // `kill` and process managers quit through the same path as ⌘Q, so the workers stop cleanly.
    for value in [SIGTERM, SIGINT] {
      signal(value, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signals.append(source)
    }
    if Snapshots.requested { Snapshots.run(); return }
    guard AppModel.canNotify else { return }
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.setNotificationCategories([
      UNNotificationCategory(identifier: "review", actions: [UNNotificationAction(identifier: "open", title: "查看变更", options: [.foreground])], intentIdentifiers: []),
    ])
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { Task { @MainActor in self.model.openMain?() } }
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    let model = self.model
    model.backend.log("Quitting")
    model.backend.stop { sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .list] }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let id = response.notification.request.content.userInfo["todoId"] as? String else { return }
    await MainActor.run { model.open(todo: id) }
  }
}

@main
struct MusterApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  private let model = AppModel.shared

  var body: some Scene {
    Window("Muster", id: "main") {
      RootView()
        .environment(model.store)
        .environment(model)
    }
    .defaultSize(width: 1360, height: 880)
    .commands { MusterCommands(model: model) }

    Settings {
      SettingsView().environment(model.store).environment(model)
    }

    MenuBarExtra {
      MenuBarContent().environment(model.store).environment(model)
    } label: {
      MenuBarLabel(model: model)
    }
  }
}

/// Lives as long as the app, so it can reopen the main window after it was closed.
private struct MenuBarLabel: View {
  var model: AppModel
  @Environment(\.openWindow) private var openWindow
  var body: some View {
    let count = model.store.needsYouCount
    HStack(spacing: 2) {
      Image(systemName: count > 0 ? "m.circle.fill" : "m.circle")
      if count > 0 { Text("\(count)") }
    }
    .onAppear { model.openMain = { openWindow(id: "main") } }
  }
}

private struct MenuBarContent: View {
  @Environment(Store.self) private var store
  @Environment(AppModel.self) private var app
  var body: some View {
    let needsYou = store.todos.filter { $0.phase.needsYou }
    let running = store.todos.filter { $0.phase.running }
    Text(!store.connected ? "正在连接…" : store.onlineMachines.isEmpty ? "没有在线的执行机" : "执行机在线 · \(running.count) 个运行中")
    if !needsYou.isEmpty {
      Divider()
      Text("需要你")
      ForEach(needsYou.prefix(8)) { todo in
        Button("\(todo.phase == .failed ? "✕" : "◉") #\(todo.number) \(todo.title)") { app.open(todo: todo.id) }
      }
    }
    if !running.isEmpty {
      Divider()
      Text("进行中")
      ForEach(running.prefix(8)) { todo in Button("#\(todo.number) \(todo.title)") { app.open(todo: todo.id) } }
    }
    Divider()
    Button("打开 Muster") { app.openMain?(); NSApp.activate(ignoringOtherApps: true) }
    Button("新建任务…") { app.openMain?(); NSApp.activate(ignoringOtherApps: true); app.sheet = .task }.disabled(store.projects.isEmpty)
    Divider()
    Button("退出 Muster") { NSApp.terminate(nil) }.keyboardShortcut("q")
  }
}

private struct MusterCommands: Commands {
  var model: AppModel
  @FocusedValue(\.taskCommands) private var task

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("新建任务…") { model.sheet = .task }.keyboardShortcut("n").disabled(model.store.projects.isEmpty)
      Button("新建工作空间…") { model.sheet = .workspace }.keyboardShortcut("n", modifiers: [.command, .shift])
      Divider()
      Button("快速打开…") { model.sheet = .quickOpen }.keyboardShortcut("k")
      Divider()
      Button("在浏览器中打开") { if let origin = model.store.api?.origin { NSWorkspace.shared.open(origin) } }
      Button("显示日志") { NSWorkspace.shared.activateFileViewerSelecting([model.backend.logs]) }
    }
    CommandMenu("工作空间") {
      Button("主会话") { if let p = model.store.workspace { model.store.route = .conversation(p.id) } }.keyboardShortcut("1")
      Button("看板") { if let p = model.store.workspace { model.store.route = .board(p.id) } }.keyboardShortcut("2")
      Button("Agent") { model.store.route = .agents }.keyboardShortcut("3")
      Button("用量") { model.store.route = .usage }.keyboardShortcut("4")
      Divider()
      ForEach(Array(model.store.projects.prefix(9).enumerated()), id: \.element.id) { index, project in
        Button(project.name) { model.store.workspaceId = project.id; model.store.route = .conversation(project.id) }
          .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.command, .option])
      }
      Divider()
      Button("工作空间设置…") { if let p = model.store.workspace { model.store.route = .workspaceSettings(p.id) } }.disabled(model.store.workspace == nil)
    }
    CommandMenu("任务") {
      Button(task?.start != nil ? "开始" : "完成并合并…") { (task?.start ?? task?.complete)?() }
        .keyboardShortcut(.return, modifiers: .command).disabled(task?.start == nil && task?.complete == nil)
      Button("重新运行…") { task?.rerun?() }.keyboardShortcut("r").disabled(task?.rerun == nil)
      Button("停止") { task?.stop?() }.keyboardShortcut(".").disabled(task?.stop == nil)
      Button("关闭任务") { task?.close?() }.keyboardShortcut(.delete).disabled(task?.close == nil)
      Divider()
      Button(model.inspector ? "隐藏变更" : "显示变更") { model.inspector.toggle() }.keyboardShortcut("i", modifiers: [.command, .option])
    }
  }
}
