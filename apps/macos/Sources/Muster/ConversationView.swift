import SwiftUI
import AppKit

/// A conversation with an agent: the message stream, live status and a floating composer.
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
  @State private var atBottom = true
  @Namespace private var glass

  private var messages: [Message] { store.messages[conversationId] ?? [] }
  private var activity: Activity { store.activity[conversationId] ?? Activity() }
  private var status: String {
    if let todoId, let todo = store.todo(todoId) { return todo.phase == .building ? "running" : todo.phase == .queued ? "queued" : "idle" }
    return activity.status
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          if let initialSpec, !initialSpec.isEmpty { SpecCard(spec: initialSpec) }
          if messages.isEmpty, todoId == nil { Greeting(name: agentName, suggestions: suggestions) { draft = $0; focus += 1 } }
          ForEach(Self.groups(messages), id: \.id) { group in
            switch group {
            case .tools(let items): ToolStrip(messages: items)
            case .message(let message): MessageRow(message: message, agentName: agentName)
            }
          }
          if status != "idle" { LiveStatus(status: status, detail: activity.detail, queuedHint: queuedHint, agentName: agentName) }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 16)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
      }
      // Short conversations start at the top; long ones open at the latest message and follow new output.
      .defaultScrollAnchor(.top, for: .alignment)
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .scrollContentBackground(.hidden)
      .softScrollEdges()
      .onScrollGeometryChange(for: Bool.self) { geo in
        geo.visibleRect.maxY >= geo.contentSize.height - 80
      } action: { _, bottom in withAnimation(.snappy) { atBottom = bottom } }
      .onChange(of: messages.last?.content) { if atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
      .onChange(of: messages.count) { if atBottom { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } } }
      // The composer floats over the conversation as glass; content scrolls beneath it.
      .edgeBar(.bottom) { composer { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } } }
    }
    .task(id: conversationId) {
      if store.messages[conversationId] == nil { store.messages[conversationId] = [] }
      await store.loadMessages(conversationId)
      store.activity[conversationId, default: Activity()].unread = false
    }
  }

  /// One glass container, so the queued messages, the jump button and the composer blend and morph together.
  private func composer(jump: @escaping () -> Void) -> some View {
    GlassContainer(spacing: 10) {
      VStack(alignment: .trailing, spacing: 10) {
        if !atBottom {
          Button(action: jump) { Image(systemName: "arrow.down").font(.system(size: 13, weight: .semibold)).frame(width: 34, height: 34) }
            .buttonStyle(.plain).glassCircle().glassID("jump", in: glass)
            .help("回到最新消息").transition(.scale.combined(with: .opacity))
        }
        VStack(alignment: .leading, spacing: 8) {
          QueuedList(conversationId: conversationId, namespace: glass)
          if let warning = activity.warning {
            Label(warning, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.orange)
              .padding(.horizontal, 14).padding(.vertical, 8).glassSurface(cornerRadius: 14, tint: .orange)
          }
          ErrorBanner(message: $error)
          VStack(alignment: .leading, spacing: 6) {
            Composer(text: $draft, placeholder: disabledReason ?? placeholder, disabled: disabledReason != nil, focusToken: focus, onSubmit: send)
              .frame(minHeight: 40, maxHeight: 180)
              .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
              AgentAvatar(name: agentName, size: 16)
              Text(agentName).font(.caption.weight(.medium)).foregroundStyle(.secondary)
              if let runtime { Text(Runtimes.label(runtime)).font(.caption).foregroundStyle(.tertiary) }
              Spacer()
              Text("↩ 发送  ⇧↩ 换行").font(.caption2).foregroundStyle(.tertiary)
              Button(action: send) {
                Image(systemName: sending ? "ellipsis" : "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 18, height: 18)
              }
              .glassProminentButton(tint: .muster)
              .buttonBorderShape(.circle)
              .disabled(!canSend).help("发送（↩）")
            }
          }
          .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
          .glassSurface(cornerRadius: 22)
          .glassID("composer", in: glass)
        }
      }
    }
    .padding(.horizontal, 28).padding(.bottom, 16).padding(.top, 6)
    .frame(maxWidth: 780)
    .frame(maxWidth: .infinity)
  }

  private var canSend: Bool { disabledReason == nil && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationId.isEmpty }

  private var queuedHint: String {
    let online = store.onlineMachines
    if store.machines.isEmpty && !store.connected { return "等待执行机…" }
    if online.isEmpty { return "没有在线的执行机。Muster 会自动启动本机 daemon，稍等片刻或查看日志。" }
    if let runtime, !online.contains(where: { $0.runtimes.contains(runtime) }) { return "没有在线执行机支持 \(Runtimes.label(runtime))，请先在本机安装它。" }
    return "排队等待执行机…"
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
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 14) {
        AgentAvatar(name: name, size: 44)
        VStack(alignment: .leading, spacing: 3) {
          Text("我是 \(name)").font(.title.weight(.semibold))
          Text("这个工作空间的 master agent").foregroundStyle(.secondary)
        }
      }
      Text("告诉我目标，我会拆成可以并行的任务、分派给 Agent，并跟进每一个任务直到验收合并。")
        .font(.title3).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(suggestions, id: \.self) { suggestion in
          Button { pick(suggestion) } label: {
            HStack {
              Image(systemName: "sparkle").foregroundStyle(Color.muster)
              Text(suggestion)
              Spacer()
              Image(systemName: "arrow.turn.down.left").foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
      .frame(maxWidth: 520)
    }
    .padding(.top, 56)
  }
}

private struct SpecCard: View {
  var spec: String
  @State private var open = true
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button { withAnimation(.snappy) { open.toggle() } } label: {
        HStack(spacing: 6) {
          Image(systemName: "doc.text").foregroundStyle(Color.muster)
          Text("任务描述").font(.subheadline.weight(.semibold))
          Spacer()
          Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 0 : -90)).font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if open { MarkdownView(text: spec).transition(.opacity) }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

private struct MessageRow: View {
  @Environment(Store.self) private var store
  var message: Message
  var agentName: String
  var body: some View {
    switch message.role {
    case "system": systemPill
    case "user": userBubble
    default: agentMessage
    }
  }

  /// Your messages read like Messages: right-aligned, tinted.
  private var userBubble: some View {
    HStack {
      Spacer(minLength: 120)
      VStack(alignment: .trailing, spacing: 4) {
        MarkdownView(text: message.content)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(Color.muster.opacity(0.16), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .dimsWhenInactive()
        Text(Format.time(message.createdAt)).font(.caption2).foregroundStyle(.tertiary).padding(.trailing, 6)
      }
    }
  }

  private var agentMessage: some View {
    HStack(alignment: .top, spacing: 12) {
      AgentAvatar(name: agentName, size: 26)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(agentName).font(.headline)
          Text(Format.time(message.createdAt)).font(.caption).foregroundStyle(.tertiary)
        }
        MarkdownView(text: message.content)
        if message.streaming {
          Capsule().fill(Color.muster).frame(width: 18, height: 4)
            .phaseAnimator([0.3, 1]) { $0.opacity($1) } animation: { _ in .easeInOut(duration: 0.6) }
        }
      }
      Spacer(minLength: 0)
    }
  }

  /// A task changing phase, as a pill you can click to open the task.
  private var systemPill: some View {
    let phase = message.meta["phase"]?.string.flatMap(Phase.init)
    let todoId = message.meta["todoId"]?.string
    return HStack {
      Spacer()
      Button { if let todoId { store.route = .task(todoId) } } label: {
        HStack(spacing: 6) {
          Image(systemName: phase?.symbol ?? "info.circle").foregroundStyle(phase?.color ?? .secondary)
          Text(Self.systemText(message)).foregroundStyle(.primary)
          if todoId != nil { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary) }
        }
        .font(.callout)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background((phase?.color ?? .secondary).opacity(0.1), in: Capsule())
        .overlay(Capsule().strokeBorder((phase?.color ?? .secondary).opacity(0.25)))
      }
      .buttonStyle(.plain)
      .disabled(todoId == nil)
      Spacer()
    }
  }

  static func systemText(_ message: Message) -> String {
    if message.meta["code"]?.string == "no_file_changes" { return "本次构建没有文件变更" }
    if let phase = message.meta["phase"]?.string.flatMap(Phase.init), message.meta["todoId"] != nil {
      let number = message.meta["todoNumber"]?.number.map { "#\(Int($0))" } ?? ""
      let task = [number, message.meta["todoTitle"]?.string ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
      switch phase {
      case .review: return "\(task) 已完成，等待验收"
      case .failed: return "\(task) 执行失败"
      case .done: return "\(task) 已完成"
      default: return "\(task) 进入\(phase.label)"
      }
    }
    return message.content
  }
}

/// Tool calls as a row of pills — what the agent touched, at a glance; click to see inputs and outputs.
private struct ToolStrip: View {
  var messages: [Message]
  @State private var open = false

  static func symbol(_ tool: String) -> String {
    let t = tool.lowercased()
    if t.contains("read") || t.contains("view") || t.contains("cat") { return "doc.text" }
    if t.contains("edit") || t.contains("write") || t.contains("patch") || t.contains("apply") { return "pencil" }
    if t.contains("bash") || t.contains("shell") || t.contains("exec") || t.contains("command") { return "terminal" }
    if t.contains("grep") || t.contains("search") || t.contains("glob") || t.contains("find") { return "magnifyingglass" }
    if t.contains("create") { return "plus.square" }
    if t.contains("list") || t.contains("get") { return "list.bullet" }
    if t.contains("web") || t.contains("fetch") { return "globe" }
    return "wrench.and.screwdriver"
  }

  static func summary(_ message: Message) -> String {
    guard let input = message.meta["input"] else { return message.content }
    for key in ["file_path", "path", "command", "cmd", "pattern", "query", "title", "url"] {
      if let value = input[key]?.string { return key == "file_path" || key == "path" ? (value as NSString).lastPathComponent : value }
    }
    return input.display
  }

  var body: some View {
    let calls = messages.filter { $0.meta["type"]?.string == "tool.started" }
    let thinking = calls.isEmpty
    VStack(alignment: .leading, spacing: 8) {
      Button { withAnimation(.snappy) { open.toggle() } } label: {
        HStack(spacing: 6) {
          if thinking {
            Pill(symbol: "brain", title: "思考", detail: nil, failed: false)
          } else {
            ForEach(calls.prefix(4)) { call in
              Pill(symbol: Self.symbol(call.meta["tool"]?.string ?? ""), title: call.meta["tool"]?.string ?? "工具", detail: Self.summary(call), failed: call.meta["error"] != nil)
            }
            if calls.count > 4 { Text("+\(calls.count - 4)").font(.caption.weight(.medium)).foregroundStyle(.secondary) }
          }
          Image(systemName: "chevron.right").rotationEffect(.degrees(open ? 90 : 0)).font(.caption2).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help(open ? "收起" : "展开工具调用详情")
      if open {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(messages) { message in
            VStack(alignment: .leading, spacing: 3) {
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: Self.symbol(message.meta["tool"]?.string ?? "")).foregroundStyle(.secondary)
                Text(message.meta["tool"]?.string ?? (thinking ? "推理" : "工具")).fontWeight(.semibold)
                Text(message.meta["input"]?.display ?? message.content).foregroundStyle(.secondary).lineLimit(4)
              }
              if let output = message.meta["output"]?.display, !output.isEmpty {
                Text(output.count > 4000 ? String(output.prefix(4000)) + "\n…" : output).foregroundStyle(.secondary).padding(.leading, 20).lineLimit(30)
              }
              if let error = message.meta["error"]?.display { Text(error).foregroundStyle(.red).padding(.leading, 20) }
            }
          }
        }
        .font(.system(size: 11.5, design: .monospaced))
        .textSelection(.enabled)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(.leading, 38)
  }

  private struct Pill: View {
    var symbol: String
    var title: String
    var detail: String?
    var failed: Bool
    var body: some View {
      HStack(spacing: 5) {
        Image(systemName: failed ? "exclamationmark.triangle.fill" : symbol).foregroundStyle(failed ? .orange : .secondary)
        Text(title).fontWeight(.medium)
        if let detail, !detail.isEmpty { Text(detail).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
      }
      .font(.system(size: 11.5))
      .padding(.horizontal, 9).padding(.vertical, 4)
      .frame(maxWidth: 240, alignment: .leading)
      .fixedSize(horizontal: true, vertical: false)
      .background(.quaternary.opacity(0.55), in: Capsule())
    }
  }
}

private struct LiveStatus: View {
  var status: String
  var detail: String
  var queuedHint: String
  var agentName: String
  var body: some View {
    HStack(spacing: 10) {
      AgentAvatar(name: agentName, size: 26)
        .overlay(alignment: .bottomTrailing) {
          Circle().fill(status == "queued" ? Color.orange : Color.muster).frame(width: 9, height: 9)
            .overlay(Circle().strokeBorder(.background, lineWidth: 2))
            .offset(x: 3, y: 3)
        }
      HStack(spacing: 4) {
        ForEach(0..<3) { i in
          Circle().fill(.secondary).frame(width: 5, height: 5)
            .phaseAnimator([0.25, 1]) { $0.opacity($1) } animation: { _ in .easeInOut(duration: 0.5).delay(Double(i) * 0.15) }
        }
      }
      Text(status == "queued" ? queuedHint : detail.isEmpty ? "\(agentName) 正在工作" : detail)
        .font(.callout).foregroundStyle(.secondary).lineLimit(1)
    }
  }
}

private struct QueuedList: View {
  @Environment(Store.self) private var store
  var conversationId: String
  var namespace: Namespace.ID
  var body: some View {
    let items = store.queued[conversationId] ?? []
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text("当前一轮结束后送达").font(.caption).foregroundStyle(.secondary)
        ForEach(items) { item in
          HStack(spacing: 8) {
            Image(systemName: "clock").foregroundStyle(.orange)
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
          .padding(.horizontal, 14).padding(.vertical, 8)
          .glassSurface(cornerRadius: 14)
          .glassID("queued-\(item.id)", in: namespace)
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
