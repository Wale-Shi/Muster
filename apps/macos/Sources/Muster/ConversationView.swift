import SwiftUI
import AppKit

/// A conversation with an agent: the message stream, live status and the composer.
struct ConversationView: View {
  @Environment(Store.self) private var store
  var conversationId: String
  var todoId: String?
  var agentName: String
  var runtime: String?
  /// Why the composer is disabled, if it is.
  var disabledReason: String?
  var placeholder: String
  var initialSpec: String?
  /// Shown when the conversation is empty and there is no spec.
  var suggestions: [String] = []
  @State private var draft = ""
  @State private var sending = false
  @State private var error: String?
  @State private var focus = 0

  private var messages: [Message] { store.messages[conversationId] ?? [] }
  private var activity: Activity { store.activity[conversationId] ?? Activity() }
  private var status: String {
    if let todoId, let todo = store.todo(todoId) { return todo.phase == .building ? "running" : todo.phase == .queued ? "queued" : "idle" }
    return activity.status
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            if messages.isEmpty {
              if let initialSpec, !initialSpec.isEmpty { SpecCard(spec: initialSpec) }
              else if todoId == nil { Greeting(name: agentName, suggestions: suggestions) { draft = $0; focus += 1 } }
            }
            ForEach(Self.groups(messages), id: \.id) { group in
              switch group {
              case .tools(let items): ToolGroup(messages: items)
              case .message(let message): MessageRow(message: message, agentName: agentName)
              }
            }
            if status != "idle" { LiveStatus(status: status, detail: activity.detail, queuedHint: queuedHint) }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 24).padding(.vertical, 20)
          .frame(maxWidth: 820)
          .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .onChange(of: messages.last?.content) { proxy.scrollTo("bottom", anchor: .bottom) }
        .onChange(of: messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      Divider()
      VStack(alignment: .leading, spacing: 8) {
        QueuedList(conversationId: conversationId)
        if let warning = activity.warning {
          Label(warning, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
        }
        ErrorBanner(message: $error)
        Composer(text: $draft, placeholder: disabledReason ?? placeholder, disabled: disabledReason != nil, focusToken: focus, onSubmit: send)
          .frame(minHeight: 44, maxHeight: 160)
          .fixedSize(horizontal: false, vertical: true)
          .padding(8)
          .background(.background, in: RoundedRectangle(cornerRadius: 10))
          .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
          .overlay(alignment: .bottomTrailing) {
            Button(action: send) { Image(systemName: sending ? "ellipsis" : "arrow.up.circle.fill").font(.title2) }
              .buttonStyle(.borderless).foregroundStyle(canSend ? Color.muster : .secondary)
              .disabled(!canSend).padding(6).help("发送（↩）")
          }
        Text("↩ 发送 · ⇧↩ 换行").font(.caption2).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 24).padding(.vertical, 12)
      .frame(maxWidth: 820).frame(maxWidth: .infinity)
    }
    .task(id: conversationId) {
      if store.messages[conversationId] == nil { store.messages[conversationId] = [] }
      await store.loadMessages(conversationId)
      store.activity[conversationId, default: Activity()].unread = false
    }
  }

  private var canSend: Bool { disabledReason == nil && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationId.isEmpty }

  private var queuedHint: String {
    let online = store.onlineMachines
    if store.machines.isEmpty && !store.connected { return "等待执行机…" }
    if online.isEmpty { return "没有在线的执行机。Muster 会自动启动本机 daemon，稍等片刻或查看日志。" }
    if let runtime, !online.contains(where: { $0.runtimes.contains(runtime) }) { return "没有在线执行机支持 \(Runtimes.label(runtime))，请先在本机安装它。" }
    return "等待执行机…"
  }

  private func send() {
    let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    sending = true
    Task {
      do {
        guard let api = store.api else { return }
        if let todoId { try await api.sendTodo(todoId, content) } else { try await api.sendTopic(conversationId, content) }
        draft = ""; error = nil
        await store.loadMessages(conversationId)
      } catch { self.error = error.localizedDescription }
      sending = false
    }
  }

  enum Group: Identifiable {
    case message(Message), tools([Message])
    var id: String { switch self { case .message(let m): m.id; case .tools(let items): "tools-\(items[0].id)" } }
  }

  /// Consecutive tool and reasoning events collapse into one group.
  static func groups(_ messages: [Message]) -> [Group] {
    var groups: [Group] = []
    for message in messages {
      if message.role == "tool" {
        if case .tools(var items) = groups.last { items.append(message); groups[groups.count - 1] = .tools(items) }
        else { groups.append(.tools([message])) }
      } else { groups.append(.message(message)) }
    }
    return groups
  }
}

private struct Greeting: View {
  var name: String
  var suggestions: [String]
  var pick: (String) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      MusterMark(size: 36)
      Text("我是 \(name)，这个工作空间的 master agent").font(.title2.weight(.semibold))
      Text("告诉我目标，我会拆成可并行的任务、分派给 Agent，并跟进每个任务直到验收合并。")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 6) {
        ForEach(suggestions, id: \.self) { suggestion in
          Button { pick(suggestion) } label: { Label(suggestion, systemImage: "text.bubble") }.buttonStyle(.link)
        }
      }
    }
    .padding(.top, 40)
  }
}

private struct SpecCard: View {
  var spec: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("任务描述", systemImage: "doc.text").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
      MarkdownView(text: spec)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
  }
}

private struct MessageRow: View {
  var message: Message
  var agentName: String
  var body: some View {
    if message.role == "system" {
      HStack(spacing: 8) {
        Rectangle().fill(.separator).frame(height: 1)
        Text(Self.systemText(message)).font(.caption).foregroundStyle(.secondary).fixedSize()
        Rectangle().fill(.separator).frame(height: 1)
      }
    } else {
      let you = message.role == "user"
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Monogram(name: you ? "你" : agentName, size: 18)
          Text(you ? "你" : agentName).font(.subheadline.weight(.semibold))
          Text(Format.time(message.createdAt)).font(.caption).foregroundStyle(.tertiary)
        }
        MarkdownView(text: message.content + (message.streaming ? " ▍" : ""))
          .padding(.leading, 24)
      }
      .padding(you ? 12 : 0)
      .background(you ? AnyShapeStyle(Color.muster.opacity(0.07)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 10))
    }
  }

  static func systemText(_ message: Message) -> String {
    if message.meta["code"]?.string == "no_file_changes" { return "本次构建没有文件变更" }
    if let phase = message.meta["phase"]?.string.flatMap(Phase.init), message.meta["todoId"] != nil {
      let number = message.meta["todoNumber"]?.number.map { "#\(Int($0))" } ?? ""
      let task = [number, message.meta["todoTitle"]?.string ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
      switch phase {
      case .review: return "任务 \(task) 已完成，等待验收。"
      case .failed: return "任务 \(task) 执行失败。"
      case .done: return "任务 \(task) 已完成。"
      default: return "任务 \(task) 已进入\(phase.label)阶段。"
      }
    }
    return message.content
  }
}

private struct ToolGroup: View {
  var messages: [Message]
  @State private var open = false
  var body: some View {
    let calls = messages.filter { $0.meta["type"]?.string == "tool.started" }
    let thinking = calls.isEmpty && messages.allSatisfy { $0.meta["type"]?.string == "reasoning.delta" }
    let failed = messages.contains { $0.meta["error"] != nil }
    DisclosureGroup(isExpanded: $open) {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(messages) { message in
          VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
              Text("$").foregroundStyle(.tertiary)
              Text(message.meta["tool"]?.string ?? (thinking ? "推理" : "工具")).fontWeight(.medium)
              Text(message.meta["input"]?.display ?? message.content).foregroundStyle(.secondary).lineLimit(3)
            }
            if let output = message.meta["output"]?.display, !output.isEmpty {
              Text(output.count > 4000 ? String(output.prefix(4000)) + "\n…" : output).foregroundStyle(.secondary).padding(.leading, 12)
            }
            if let error = message.meta["error"]?.display { Text(error).foregroundStyle(.red).padding(.leading, 12) }
          }
        }
      }
      .font(.system(.caption, design: .monospaced))
      .textSelection(.enabled)
      .padding(.top, 4)
    } label: {
      Label(thinking ? "思考中" : "\(calls.isEmpty ? messages.count : calls.count) 次工具调用",
            systemImage: thinking ? "brain" : failed ? "exclamationmark.triangle" : "terminal")
        .font(.callout).foregroundStyle(failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
    }
  }
}

private struct LiveStatus: View {
  var status: String
  var detail: String
  var queuedHint: String
  var body: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text(status == "queued" ? queuedHint : "正在工作…").foregroundStyle(.secondary)
      if status == "running", !detail.isEmpty { Text(detail).foregroundStyle(.tertiary).lineLimit(1) }
    }
    .font(.callout)
  }
}

private struct QueuedList: View {
  @Environment(Store.self) private var store
  var conversationId: String
  var body: some View {
    let items = store.queued[conversationId] ?? []
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text("排队中的消息会在当前轮结束后送达").font(.caption).foregroundStyle(.secondary)
        ForEach(items) { item in
          HStack {
            Image(systemName: "clock").foregroundStyle(.secondary)
            Text(item.content).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            if !item.delivering {
              Button("撤回") {
                Task {
                  await store.perform { try await $0.retractQueued(conversationId, item.id) }
                  await store.loadMessages(conversationId)
                }
              }.buttonStyle(.link)
            }
          }
          .font(.callout)
        }
      }
    }
  }
}

/// A plain-text editor that sends on Return but leaves Return alone while an input method is composing.
struct Composer: NSViewRepresentable {
  @Binding var text: String
  var placeholder: String
  var disabled: Bool
  var focusToken: Int
  var onSubmit: () -> Void

  final class TextView: NSTextView {
    var submit: (() -> Void)?
    var placeholder = "" { didSet { needsDisplay = true } }
    override func keyDown(with event: NSEvent) {
      let plainReturn = event.keyCode == 36 || event.keyCode == 76
      if plainReturn && !hasMarkedText() && event.modifierFlags.intersection([.shift, .option, .command, .control]).isEmpty {
        submit?(); return
      }
      super.keyDown(with: event)
    }
    override func draw(_ dirtyRect: NSRect) {
      super.draw(dirtyRect)
      guard string.isEmpty else { return }
      let attributes: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.placeholderTextColor, .font: font ?? NSFont.systemFont(ofSize: 13)]
      (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height), withAttributes: attributes)
    }
    override var intrinsicContentSize: NSSize {
      guard let manager = layoutManager, let container = textContainer else { return super.intrinsicContentSize }
      manager.ensureLayout(for: container)
      return NSSize(width: NSView.noIntrinsicMetric, height: manager.usedRect(for: container).height + textContainerInset.height * 2)
    }
    override func didChangeText() { super.didChangeText(); invalidateIntrinsicContentSize() }
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: Composer
    var lastFocus = 0
    init(_ parent: Composer) { self.parent = parent }
    func textDidChange(_ notification: Notification) {
      guard let view = notification.object as? NSTextView else { return }
      parent.text = view.string
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    let view = TextView()
    view.delegate = context.coordinator
    view.isRichText = false
    view.allowsUndo = true
    view.drawsBackground = false
    view.font = .systemFont(ofSize: 13)
    view.textContainerInset = NSSize(width: 0, height: 4)
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    view.autoresizingMask = [.width]
    view.textContainer?.widthTracksTextView = true
    view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
    view.isVerticallyResizable = true
    scroll.documentView = view
    DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let view = scroll.documentView as? TextView else { return }
    context.coordinator.parent = self
    if view.string != text { view.string = text; view.invalidateIntrinsicContentSize() }
    view.placeholder = placeholder
    view.isEditable = !disabled
    view.submit = onSubmit
    if context.coordinator.lastFocus != focusToken {
      context.coordinator.lastFocus = focusToken
      DispatchQueue.main.async { view.window?.makeFirstResponder(view); view.moveToEndOfDocument(nil) }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
    let height = (nsView.documentView as? TextView)?.intrinsicContentSize.height ?? 44
    return CGSize(width: proposal.width ?? 400, height: min(max(height, 44), 160))
  }
}
