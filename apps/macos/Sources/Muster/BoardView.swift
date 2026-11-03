import SwiftUI
import UniformTypeIdentifiers

/// The workspace's tasks as four columns. Dropping a task at review onto 已完成 opens the completion sheet.
struct BoardView: View {
  @Environment(Store.self) private var store
  var project: Project
  var newTask: () -> Void
  @State private var completing: Todo?
  @State private var notice: String?

  private let columns: [(title: String, empty: String, symbol: String, match: (Todo) -> Bool)] = [
    ("待开始", "没有等待开始的任务", "tray", { $0.phase == .todo }),
    ("进行中", "没有正在执行的任务", "sparkles", { $0.phase.running }),
    ("需要你", "没有等你处理的任务", "hand.raised", { $0.phase.needsYou }),
    ("已完成", "最近 7 天没有完成的任务", "checkmark.circle", { $0.phase == .done && (Dates.parse($0.doneAt) ?? .distantPast) > Date().addingTimeInterval(-7 * 86_400) }),
  ]

  var body: some View {
    let tasks = store.tasks(in: project.id)
    VStack(alignment: .leading, spacing: 0) {
      if let notice {
        Label(notice, systemImage: "info.circle").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.top, 10)
      }
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 14) {
          ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
            let items = tasks.filter(column.match).sorted { $0.number > $1.number }
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text(column.title).font(.headline)
                Text("\(items.count)").foregroundStyle(.secondary).monospacedDigit()
                if index == 3 { Text("近 7 天").font(.caption).foregroundStyle(.tertiary) }
                Spacer()
                if index == 0 { Button(action: newTask) { Image(systemName: "plus") }.buttonStyle(.borderless).help("新建任务（⌘N）") }
              }
              ScrollView {
                LazyVStack(spacing: 8) {
                  ForEach(items) { Card(todo: $0) }
                  if items.isEmpty {
                    Label(column.empty, systemImage: column.symbol).font(.callout).foregroundStyle(.tertiary)
                      .frame(maxWidth: .infinity).padding(.vertical, 24)
                  }
                }
              }
            }
            .padding(10)
            .frame(minWidth: 250, idealWidth: 300, maxWidth: 360)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .dropDestination(for: String.self) { ids, _ in
              guard index == 3, let todo = ids.first.flatMap({ id in tasks.first { $0.id == id } }) else { return false }
              if todo.phase == .review { completing = todo } else { show("只有待验收的任务可以标记为完成。") }
              return true
            }
          }
        }
        .padding(16)
      }
    }
    .navigationTitle(project.name)
    .navigationSubtitle("看板")
    .sheet(item: $completing) { CompleteSheet(todo: $0) }
  }

  private func show(_ text: String) {
    notice = text
    Task { try? await Task.sleep(for: .seconds(5)); if notice == text { notice = nil } }
  }
}

private struct Card: View {
  @Environment(Store.self) private var store
  var todo: Todo
  var body: some View {
    let live = todo.phase.running ? store.live[todo.id] : nil
    Button { store.route = .task(todo.id) } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 5) {
          PhaseGlyph(phase: todo.phase)
          Text("#\(todo.number)").foregroundStyle(.secondary).monospacedDigit()
          if todo.phase.needsYou { Text(todo.phase.label).font(.caption.weight(.medium)).foregroundStyle(todo.phase.color) }
          Spacer()
          Text(Format.age(todo.updatedAt)).font(.caption).foregroundStyle(.tertiary)
        }
        Text(todo.title).font(.body.weight(.medium)).multilineTextAlignment(.leading).lineLimit(3)
        if let live {
          Text(live.text).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Color.muster).lineLimit(2)
        }
        if let agent = store.agent(todo.agentId) {
          HStack(spacing: 5) { AgentAvatar(name: agent.name, size: 16); Text(agent.name) }.font(.caption).foregroundStyle(.secondary)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(todo.phase.needsYou ? todo.phase.color.opacity(0.45) : Color.primary.opacity(0.08)))
      .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
      .contentShape(RoundedRectangle(cornerRadius: 11))
    }
    .buttonStyle(.plain)
    .draggable(todo.id)
    .contextMenu { TaskMenu(todo: todo) }
  }
}
