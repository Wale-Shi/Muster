import SwiftUI
import Charts

// MARK: Agents

struct AgentsView: View {
  @Environment(Store.self) private var store
  @State private var creating = false
  var body: some View {
    let installed = Set(store.onlineMachines.flatMap(\.runtimes))
    List {
      ForEach(store.agents) { agent in
        let active = store.todos.filter { $0.agentId == agent.id && ![.todo, .done, .closed].contains($0.phase) }.count
        let leads = store.projects.filter { $0.chiefAgentId == agent.id }.count
        Button { store.route = .agent(agent.id) } label: {
          HStack(alignment: .top, spacing: 12) {
            Monogram(name: agent.name, size: 32)
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(agent.name).font(.headline)
                if agent.isChief { Tag(text: "默认 master") } else if leads > 0 { Tag(text: "master") }
                if !installed.isEmpty && !installed.contains(agent.runtime) && agent.runtime != "mock" {
                  Tag(text: "本机未安装", tint: .orange).help("没有在线执行机支持 \(Runtimes.label(agent.runtime))")
                }
              }
              Text(agent.role).foregroundStyle(.secondary).lineLimit(2)
              Text("\(Runtimes.label(agent.runtime)) · \(agent.model == "default" ? "CLI 默认模型" : agent.model)\(agent.reasoning.map { " · \($0)" } ?? "")")
                .font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            Spacer()
            if active > 0 { Label("\(active) 个进行中", systemImage: "circle.fill").font(.caption).foregroundStyle(Color.muster) }
          }
          .padding(.vertical, 4)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    .overlay { if store.agents.isEmpty { ContentUnavailableView("还没有 Agent", systemImage: "person.2", description: Text("创建一个编码 Agent，让 master agent 给它派活。")) } }
    .navigationTitle("Agent")
    .toolbar { Button { creating = true } label: { Label("新建 Agent", systemImage: "plus") } }
    .sheet(isPresented: $creating) { NewAgentSheet() }
  }
}

struct Tag: View {
  var text: String
  var tint: Color = .muster
  var body: some View {
    Text(text).font(.caption2.weight(.medium)).foregroundStyle(tint)
      .padding(.horizontal, 6).padding(.vertical, 1).background(tint.opacity(0.12), in: Capsule())
  }
}

/// Models the online machines reported for a runtime, merged by id.
func reportedModels(_ machines: [Machine], _ runtime: String) -> [RuntimeModel] {
  var seen: [String: RuntimeModel] = [:], order: [String] = []
  for model in machines.compactMap({ $0.models?[runtime] }).flatMap(\.models) where seen[model.id] == nil { seen[model.id] = model; order.append(model.id) }
  return order.compactMap { seen[$0] }
}

struct ModelPicker: View {
  @Environment(Store.self) private var store
  var runtime: String
  @Binding var model: String
  @State private var custom = false
  @State private var refreshing = false
  var body: some View {
    let models = reportedModels(store.machines, runtime)
    HStack {
      if custom {
        TextField("模型 ID", text: $model).font(.body.monospaced()).onSubmit { custom = false }
      } else {
        Picker("模型", selection: $model) {
          if runtime != "mock" { Text("CLI 默认模型").tag("default") }
          ForEach(models, id: \.id) { Text($0.name ?? $0.id).tag($0.id) }
          if !models.contains(where: { $0.id == model }) && model != "default" { Text("\(model)（未上报）").tag(model) }
        }
        .labelsHidden()
        Button("自定义") { custom = true }.buttonStyle(.link)
      }
      Button {
        refreshing = true
        Task { await store.perform { try await $0.refreshModels() }; try? await Task.sleep(for: .seconds(4)); await store.load("machines") { store.machines = try await $0.machines() }; refreshing = false }
      } label: { Image(systemName: "arrow.clockwise") }
        .buttonStyle(.borderless).disabled(refreshing).help("让执行机重新读取模型列表")
    }
  }
}

func reasoningLevels(_ machines: [Machine], _ runtime: String, _ model: String) -> [String] {
  let models = reportedModels(machines, runtime)
  let levels = model == "default" ? models.flatMap { $0.reasoning ?? [] } : models.first { $0.id == model }?.reasoning ?? []
  var seen = Set<String>()
  let unique = levels.filter { seen.insert($0).inserted }
  return unique.isEmpty ? ["low", "medium", "high"] : unique
}

struct NewAgentSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var role = ""
  @State private var runtime = "codex"
  @State private var model = "default"
  @State private var reasoning = ""
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("新建 Agent").font(.title3.weight(.semibold))
      Form {
        TextField("名称", text: $name, prompt: Text("例如 Atlas"))
        TextField("职责", text: $role, prompt: Text("这个 Agent 负责什么？master agent 会据此分派任务"), axis: .vertical).lineLimit(2...4)
        Picker("运行时", selection: $runtime) { ForEach(Runtimes.all, id: \.id) { Text($0.label).tag($0.id) } }
          .onChange(of: runtime) { model = Runtimes.defaultModel(runtime); reasoning = "" }
        LabeledContent("模型") { ModelPicker(runtime: runtime, model: $model) }
        Picker("推理强度", selection: $reasoning) {
          Text("默认").tag("")
          ForEach(reasoningLevels(store.machines, runtime, model), id: \.self) { Text($0).tag($0) }
        }
      }
      ErrorBanner(message: $error)
      HStack {
        Spacer()
        Button("取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button("创建 Agent") {
          Task {
            do {
              guard let api = store.api else { return }
              let agent = try await api.createAgent(.init(name: name.trimmingCharacters(in: .whitespaces), role: role.trimmingCharacters(in: .whitespaces), runtime: runtime, model: model, reasoning: reasoning.isEmpty ? nil : reasoning))
              store.agents.append(agent); store.route = .agent(agent.id); dismiss()
            } catch { self.error = error.localizedDescription }
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled([name, role, model].contains { $0.trimmingCharacters(in: .whitespaces).isEmpty })
      }
    }
    .padding(20).frame(width: 520)
  }
}

struct AgentDetailView: View {
  @Environment(Store.self) private var store
  var id: String
  @State private var profile: AgentProfile?
  @State private var name = ""
  @State private var role = ""
  @State private var deleting = false
  var body: some View {
    if let agent = store.agent(id) {
      Form {
        Section {
          HStack(spacing: 12) {
            Monogram(name: agent.name, size: 40)
            VStack(alignment: .leading) {
              TextField("名称", text: $name).font(.title2.weight(.semibold)).textFieldStyle(.plain).disabled(agent.isChief)
                .onSubmit { save(["name": .string(name)]) }
              Text(agent.id).font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
          }
          TextField("职责", text: $role, axis: .vertical).lineLimit(2...6).onSubmit { save(["role": .string(role)]) }
          if role != agent.role { Button("保存职责") { save(["role": .string(role)]) } }
        } footer: { Text("职责会注入这个 Agent 的每个任务，也是 master agent 分派任务的依据。") }

        Section("运行配置") {
          Picker("运行时", selection: Binding(get: { agent.runtime }, set: { save(["runtime": .string($0), "model": .string(Runtimes.defaultModel($0)), "reasoning": .null]) })) {
            ForEach(Runtimes.all, id: \.id) { Text($0.label).tag($0.id) }
          }
          LabeledContent("模型") {
            ModelPicker(runtime: agent.runtime, model: Binding(get: { agent.model }, set: { if $0 != agent.model { save(["model": .string($0)]) } }))
          }
          Picker("推理强度", selection: Binding(get: { agent.reasoning ?? "" }, set: { save(["reasoning": $0.isEmpty ? .null : .string($0)]) })) {
            Text("默认").tag("")
            ForEach(reasoningLevels(store.machines, agent.runtime, agent.model), id: \.self) { Text($0).tag($0) }
          }
        }

        Section("权限") {
          let permissions = agent.permissions ?? AgentPermissions(createSkills: false, updateSkills: false)
          Toggle("可以创建技能", isOn: Binding(get: { permissions.createSkills }, set: { save(["permissions": .object(["createSkills": .bool($0), "updateSkills": .bool(permissions.updateSkills)])]) }))
          Toggle("可以更新技能", isOn: Binding(get: { permissions.updateSkills }, set: { save(["permissions": .object(["createSkills": .bool(permissions.createSkills), "updateSkills": .bool($0)])]) }))
        }

        if let profile {
          if agent.isChief || !profile.workspaces.isEmpty {
            Section("担任 master 的工作空间") {
              ForEach(profile.workspaces) { project in
                Button { store.workspaceId = project.id; store.route = .conversation(project.id) } label: { LabeledContent(project.name, value: project.baseBranch) }.buttonStyle(.plain)
              }
              if profile.workspaces.isEmpty { Text("没有工作空间指定它；未指定 master 的工作空间会使用它。").foregroundStyle(.secondary) }
            }
          }
          Section("进行中的任务") {
            ForEach(profile.inProgress) { todo in
              Button { store.route = .task(todo.id) } label: { HStack { PhaseGlyph(phase: todo.phase); Text("#\(todo.number) \(todo.title)"); Spacer(); Text(todo.phase.label).foregroundStyle(.secondary) } }.buttonStyle(.plain)
            }
            if profile.inProgress.isEmpty { Text("当前没有任务").foregroundStyle(.secondary) }
          }
        }

        if !agent.isChief {
          Section {
            Button("删除 Agent…", role: .destructive) { deleting = true }
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(agent.name)
      .task(id: agent) {
        name = agent.name; role = agent.role
        profile = try? await store.api?.agentProfile(id)
      }
      .confirmationDialog("删除 \(agent.name)？", isPresented: $deleting) {
        Button("删除", role: .destructive) { Task { if await store.perform({ try await $0.deleteAgent(id) }) { store.agents.removeAll { $0.id == id }; store.route = .agents } } }
      } message: { Text("已分派给它的任务会改用默认 Agent。这个操作不能撤销。") }
    } else {
      ContentUnavailableView("找不到这个 Agent", systemImage: "person.crop.circle.badge.questionmark")
    }
  }

  private func save(_ patch: [String: JSONValue]) {
    Task {
      guard let api = store.api else { return }
      do {
        let updated = try await api.updateAgent(id, patch)
        if let i = store.agents.firstIndex(where: { $0.id == id }) { store.agents[i] = updated }
      } catch { store.lastError = error.localizedDescription }
    }
  }
}

// MARK: Usage

struct UsageView: View {
  @Environment(Store.self) private var store
  @State private var days: Int? = 30
  @State private var rows: [UsageRow] = []
  @State private var error: String?
  var body: some View {
    let total = rows.reduce(0) { $0 + $1.tokensIn + $1.tokensOut }
    let byAgent = AgentUsage.group(rows)
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        ErrorBanner(message: $error)
        HStack(alignment: .firstTextBaseline, spacing: 28) {
          Stat(value: Format.tokens(total), label: "tokens")
          Stat(value: "\(rows.reduce(0) { $0 + $1.turns })", label: "轮执行")
          Stat(value: Format.duration(rows.reduce(0) { $0 + $1.durationMs }), label: "运行时长")
        }
        if rows.isEmpty {
          ContentUnavailableView("这段时间没有用量", systemImage: "chart.bar", description: Text("Agent 执行任务后，这里会按天显示 token 用量。"))
        } else {
          Chart(rows, id: \.self) { row in
            BarMark(x: .value("日期", Dates.day(row.day), unit: .day), y: .value("Tokens", row.tokensIn + row.tokensOut))
              .foregroundStyle(by: .value("Agent", row.agentName))
          }
          .chartLegend(position: .bottom, alignment: .leading)
          .frame(height: 240)
          Table(byAgent, columns: {
            TableColumn("Agent", value: \.name)
            TableColumn("Tokens") { Text(Format.tokens($0.tokens)).monospacedDigit() }
            TableColumn("轮次") { Text("\($0.turns)").monospacedDigit() }
          })
          .frame(minHeight: 200)
        }
      }
      .padding(24)
    }
    .navigationTitle("用量")
    .toolbar {
      Picker("时间范围", selection: $days) {
        Text("7 天").tag(Int?.some(7)); Text("30 天").tag(Int?.some(30)); Text("90 天").tag(Int?.some(90)); Text("全部").tag(Int?.none)
      }
      .pickerStyle(.segmented)
    }
    .task(id: days) {
      do { rows = try await store.api?.usage(days: days) ?? [] } catch { self.error = error.localizedDescription }
    }
  }
}

private struct AgentUsage: Identifiable {
  var name: String
  var tokens: Int
  var turns: Int
  var id: String { name }
  static func group(_ rows: [UsageRow]) -> [AgentUsage] {
    var totals: [String: AgentUsage] = [:]
    for row in rows {
      var entry = totals[row.agentName] ?? AgentUsage(name: row.agentName, tokens: 0, turns: 0)
      entry.tokens += row.tokensIn + row.tokensOut
      entry.turns += row.turns
      totals[row.agentName] = entry
    }
    return totals.values.sorted { $0.tokens > $1.tokens }
  }
}

private struct Stat: View {
  var value: String
  var label: String
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(value).font(.system(size: 28, weight: .semibold)).monospacedDigit()
      Text(label).foregroundStyle(.secondary)
    }
  }
}

extension Dates {
  static func day(_ value: String) -> Date {
    let parts = value.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return Date() }
    return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date()
  }
}

// MARK: Skills and connections

/// Skills and connections are listed natively; importing and editing stay in the browser UI, which owns those forms.
struct SkillsView: View {
  @Environment(Store.self) private var store
  @State private var skills: [Skill] = []
  @State private var error: String?
  var body: some View {
    List {
      ErrorBanner(message: $error)
      ForEach(skills) { skill in
        VStack(alignment: .leading, spacing: 3) {
          HStack { Text(skill.name).font(.headline); Text("@\(skill.slug)").font(.caption.monospaced()).foregroundStyle(.secondary) }
          Text(skill.description).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.vertical, 3)
        .contextMenu { Button("在浏览器中打开") { openWeb("skills/\(skill.slug)") } }
      }
    }
    .overlay { if skills.isEmpty && error == nil { ContentUnavailableView("还没有技能", systemImage: "book.closed", description: Text("技能是包含 SKILL.md 的文件夹，可以从 GitHub 或本地导入。")) } }
    .navigationTitle("技能")
    .toolbar { Button { openWeb("skills/new") } label: { Label("导入技能", systemImage: "square.and.arrow.down") }.help("在浏览器中导入技能") }
    .task { do { skills = try await store.api?.skills() ?? [] } catch { self.error = error.localizedDescription } }
  }
  private func openWeb(_ path: String) { if let origin = store.api?.origin { NSWorkspace.shared.open(origin.appending(path: path)) } }
}

struct ConnectionsView: View {
  @Environment(Store.self) private var store
  @State private var connections: [Connection] = []
  @State private var error: String?
  var body: some View {
    List {
      ErrorBanner(message: $error)
      ForEach(connections) { connection in
        VStack(alignment: .leading, spacing: 3) {
          HStack { Text(connection.name).font(.headline); Tag(text: connection.transport == "http" ? "远程" : "本地命令", tint: .secondary) }
          Text(connection.url ?? connection.command ?? "").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
          Text("工具前缀 mcp__\(connection.identifier)__").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
      }
    }
    .overlay { if connections.isEmpty && error == nil { ContentUnavailableView("还没有连接", systemImage: "point.3.connected.trianglepath.dotted", description: Text("连接外部 MCP 服务器后，可以授权给指定 Agent 使用。")) } }
    .navigationTitle("连接")
    .toolbar { Button { if let origin = store.api?.origin { NSWorkspace.shared.open(origin.appending(path: "connections")) } } label: { Label("管理连接", systemImage: "safari") }.help("在浏览器中添加或编辑连接") }
    .task { do { connections = try await store.api?.connections() ?? [] } catch { self.error = error.localizedDescription } }
  }
}

// MARK: Workspace settings

struct WorkspaceSettingsView: View {
  @Environment(Store.self) private var store
  var id: String
  @State private var name = ""
  @State private var branch = ""
  @State private var description = ""
  @State private var deleting = false
  @State private var saved = false
  var body: some View {
    if let project = store.project(id) {
      let endpoint = (store.api?.origin.absoluteString ?? "http://127.0.0.1:7420") + "/api/mcp/workspaces/\(project.id)"
      let slug = "muster-" + project.name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
      Form {
        Section("详情") {
          TextField("名称", text: $name)
          TextField("基准分支", text: $branch).font(.body.monospaced())
          TextField("描述", text: $description, prompt: Text("给 master agent 的背景说明"), axis: .vertical).lineLimit(3...8)
          LabeledContent("仓库") { Text(project.repoUrl).font(.callout.monospaced()).textSelection(.enabled) }
          HStack {
            Spacer()
            if saved { Text("已保存").foregroundStyle(.secondary) }
            Button("保存") { save(["name": .string(name), "baseBranch": .string(branch), "description": .string(description)]) }
              .disabled(name.isEmpty || branch.isEmpty)
          }
        }
        Section {
          Picker("Master agent", selection: Binding(get: { project.chiefAgentId ?? "" }, set: { save(["chiefAgentId": $0.isEmpty ? .null : .string($0)]) })) {
            Text("默认（\(store.agents.first { $0.isChief }?.name ?? "Chief")）").tag("")
            ForEach(store.agents.filter { !$0.isChief }) { Text("\($0.name) · \(Runtimes.label($0.runtime))").tag($0.id) }
          }
        } header: { Text("Master agent") } footer: { Text("负责拆分目标、派发和验收这个工作空间的任务。") }
        Section {
          LabeledContent("MCP 地址") {
            HStack { Text(endpoint).font(.caption.monospaced()).textSelection(.enabled); CopyButton(value: endpoint) }
          }
          LabeledContent("Claude Code") { CopyButton(value: "claude mcp add --transport http \(slug) \(endpoint) --header \"Authorization: Bearer <key>\"") }
          LabeledContent("Codex") { CopyButton(value: "[mcp_servers.\(slug.replacingOccurrences(of: "-", with: "_"))]\nurl = \"\(endpoint)\"\nhttp_headers = { Authorization = \"Bearer <key>\" }") }
        } header: { Text("让其他 AI 派活") } footer: { Text("在 设置 → API 密钥 创建一个密钥，替换命令里的 <key>。这个地址只能访问本工作空间。") }
        Section {
          Button("删除工作空间…", role: .destructive) { deleting = true }
        } footer: { Text("只删除 Muster 里的记录，不会动仓库。") }
      }
      .formStyle(.grouped)
      .navigationTitle("\(project.name) 设置")
      .task(id: project) { name = project.name; branch = project.baseBranch; description = project.description ?? "" }
      .confirmationDialog("删除工作空间 \(project.name)？", isPresented: $deleting) {
        Button("删除", role: .destructive) {
          Task {
            if await store.perform({ try await $0.deleteProject(id) }) {
              store.projects.removeAll { $0.id == id }
              store.workspaceId = store.projects.first?.id
              store.route = store.workspaceId.map { .conversation($0) }
            }
          }
        }
      } message: { Text("它的任务和主会话会一并删除。这个操作不能撤销。") }
    }
  }

  private func save(_ patch: [String: JSONValue]) {
    Task {
      guard let api = store.api else { return }
      do {
        let updated = try await api.updateProject(id, patch)
        if let i = store.projects.firstIndex(where: { $0.id == id }) { store.projects[i] = updated }
        saved = true; try? await Task.sleep(for: .seconds(2)); saved = false
      } catch { store.lastError = error.localizedDescription }
    }
  }
}

struct CopyButton: View {
  var value: String
  @State private var copied = false
  var body: some View {
    Button(copied ? "已复制" : "复制") {
      Clipboard.copy(value); copied = true
      Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
  }
}
