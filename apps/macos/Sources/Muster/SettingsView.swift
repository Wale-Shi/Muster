import SwiftUI

/// The ⌘, window.
struct SettingsView: View {
  var body: some View {
    TabView {
      GeneralSettings().tabItem { Label("通用", systemImage: "gearshape") }
      NotificationSettings().tabItem { Label("通知", systemImage: "bell.badge") }
      KeySettings().tabItem { Label("API 密钥", systemImage: "key") }
      MCPSettings().tabItem { Label("MCP", systemImage: "point.3.connected.trianglepath.dotted") }
    }
    .frame(width: 560, height: 440)
  }
}

private struct GeneralSettings: View {
  @Environment(Store.self) private var store
  @Environment(AppModel.self) private var app
  @State private var name = ""
  var body: some View {
    Form {
      TextField("名称", text: $name).onSubmit(save)
      if let settings = store.settings, name != settings.workspaceName { Button("保存", action: save) }
      LabeledContent("服务地址") { Text(store.api?.origin.absoluteString ?? "—").font(.body.monospaced()).textSelection(.enabled) }
      LabeledContent("数据目录") {
        Button(app.backend.data.path) { NSWorkspace.shared.activateFileViewerSelecting([app.backend.data]) }.buttonStyle(.link)
      }
      LabeledContent("日志") {
        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([app.backend.logs]) }
      }
      if let error = store.lastError { Text(error).foregroundStyle(.red) }
    }
    .formStyle(.grouped)
    .onAppear { name = store.settings?.workspaceName ?? "Muster" }
  }
  private func save() {
    Task { await store.perform { store.settings = try await $0.saveSettings(["workspaceName": .string(name)]) } }
  }
}

private struct NotificationSettings: View {
  @Environment(Store.self) private var store
  var body: some View {
    Form {
      if let settings = store.settings {
        Section {
          toggle("任务等待验收", \.review, settings)
          toggle("任务失败", \.failed, settings)
          toggle("任务完成", \.done, settings)
        } header: { Text("发送通知") } footer: { Text("点击通知会打开对应任务。") }
        Section { toggle("在 Dock 图标上显示需要你处理的任务数", \.dockBadge, settings) }
      } else { ProgressView() }
    }
    .formStyle(.grouped)
  }

  private func toggle(_ title: String, _ key: WritableKeyPath<NotificationPreferences, Bool>, _ settings: WorkspaceSettings) -> some View {
    Toggle(title, isOn: Binding(get: { settings.notifications[keyPath: key] }, set: { value in
      var next = settings.notifications; next[keyPath: key] = value
      let object: [String: JSONValue] = ["review": .bool(next.review), "failed": .bool(next.failed), "done": .bool(next.done), "dockBadge": .bool(next.dockBadge)]
      Task { await store.perform { store.settings = try await $0.saveSettings(["notifications": .object(object)]) } }
    }))
  }
}

private struct KeySettings: View {
  @Environment(Store.self) private var store
  @State private var keys: [ApiKey] = []
  @State private var name = ""
  @State private var scope = "chief"
  @State private var created: String?
  @State private var error: String?
  var body: some View {
    Form {
      Section {
        TextField("名称", text: $name, prompt: Text("例如 Claude Code"))
        Picker("权限", selection: $scope) { Text("派活和管理任务").tag("chief"); Text("只读").tag("read") }
        Button("创建密钥", action: create).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
      } header: { Text("新建密钥") } footer: { Text("其他 AI 用这个密钥通过 MCP 接入工作空间。") }
      if let created {
        Section {
          Text(created).font(.body.monospaced()).textSelection(.enabled)
          CopyButton(value: created)
        } header: { Text("新密钥") } footer: { Text("完整密钥只显示这一次，请现在复制保存。") }
      }
      Section("已有密钥") {
        ForEach(keys) { key in
          HStack {
            VStack(alignment: .leading) {
              Text(key.name)
              Text("\(key.prefix)… · \(key.scopes.contains("chief") ? "派活" : "只读") · 最近使用 \(key.lastUsedAt.map(Format.age) ?? "从未")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if key.revokedAt != nil { Text("已吊销").foregroundStyle(.secondary) }
            else { Button("吊销", role: .destructive) { Task { await store.perform { try await $0.revokeKey(key.id) }; await reload() } } }
          }
        }
        if keys.isEmpty { Text("还没有密钥").foregroundStyle(.secondary) }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .formStyle(.grouped)
    .task { await reload() }
  }
  private func reload() async { do { keys = try await store.api?.apiKeys() ?? [] } catch { self.error = error.localizedDescription } }
  private func create() {
    Task {
      do { created = try await store.api?.createKey(.init(name: name, scopes: [scope])); name = ""; await reload() }
      catch { self.error = error.localizedDescription }
    }
  }
}

private struct MCPSettings: View {
  @Environment(Store.self) private var store
  var body: some View {
    let origin = store.api?.origin.absoluteString ?? "http://127.0.0.1:7420"
    Form {
      Section {
        LabeledContent("所有工作空间") { HStack { Text("\(origin)/api/mcp").font(.caption.monospaced()); CopyButton(value: "\(origin)/api/mcp") } }
        ForEach(store.projects) { project in
          LabeledContent(project.name) { CopyButton(value: "\(origin)/api/mcp/workspaces/\(project.id)") }
        }
      } header: { Text("MCP 地址") } footer: { Text("工作空间地址只能访问该工作空间；全局地址调用时需要传 workspaceId。") }
      Section("主要工具") {
        LabeledContent("assign_work", value: "把目标交给 master agent")
        LabeledContent("create_task", value: "直接创建任务")
        LabeledContent("get_workspace", value: "查看任务和阶段")
        LabeledContent("get_task_log", value: "读取执行日志")
        LabeledContent("complete_task", value: "完成并合并任务")
      }
    }
    .formStyle(.grouped)
  }
}
