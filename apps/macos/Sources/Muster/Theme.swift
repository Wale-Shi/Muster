import SwiftUI
import AppKit

extension Color {
  /// Muster indigo: the brand accent, also used for running work.
  static let muster = Color(nsColor: NSColor(name: "muster") { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? NSColor(srgbRed: 0x8B / 255, green: 0x8C / 255, blue: 0xF8 / 255, alpha: 1)
      : NSColor(srgbRed: 0x5B / 255, green: 0x5B / 255, blue: 0xD6 / 255, alpha: 1)
  })
}

extension Phase {
  var label: String {
    switch self {
    case .todo: "待开始"
    case .queued: "排队中"
    case .building: "执行中"
    case .review: "待验收"
    case .failed: "失败"
    case .done: "已完成"
    case .closed: "已关闭"
    }
  }
  var color: Color {
    switch self {
    case .todo, .closed: .secondary
    case .queued, .building: .muster
    case .review: .orange
    case .failed: .red
    case .done: .green
    }
  }
  var symbol: String {
    switch self {
    case .todo: "circle.dashed"
    case .queued: "clock"
    case .building: "circle.dotted.circle"
    case .review: "eye.circle.fill"
    case .failed: "xmark.circle.fill"
    case .done: "checkmark.circle.fill"
    case .closed: "minus.circle"
    }
  }
}

/// A phase glyph; running phases pulse so motion means "work is happening" and nothing else.
struct PhaseGlyph: View {
  var phase: Phase
  var body: some View {
    Image(systemName: phase.symbol)
      .foregroundStyle(phase.color)
      .symbolEffect(.pulse, options: .repeating, isActive: phase == .building)
      .help(phase.label)
      .accessibilityLabel(phase.label)
  }
}

struct PhaseBadge: View {
  var phase: Phase
  var body: some View {
    Label(phase.label, systemImage: phase.symbol)
      .font(.caption.weight(.medium))
      .foregroundStyle(phase.color)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(phase.color.opacity(0.12), in: Capsule())
  }
}

/// The Muster mark: four strokes whose joints are rings, the second one solid like a lead node.
struct MusterMark: View {
  var size: CGFloat = 16
  private static let nodes: [CGPoint] = [.init(x: 5, y: 19.5), .init(x: 5.8, y: 4.8), .init(x: 11.2, y: 14.2), .init(x: 18.2, y: 7.4), .init(x: 19.2, y: 18.8)]
  var body: some View {
    Canvas { context, canvas in
      let scale = canvas.width / 24, ring = 1.5 * scale
      let points = Self.nodes.map { CGPoint(x: $0.x * scale, y: $0.y * scale) }
      var path = Path()
      for (a, b) in zip(points, points.dropFirst()) {
        let length = hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
        path.move(to: CGPoint(x: a.x + ux * ring, y: a.y + uy * ring)); path.addLine(to: CGPoint(x: b.x - ux * ring, y: b.y - uy * ring))
      }
      context.stroke(path, with: .style(.primary), style: StrokeStyle(lineWidth: 1.7 * scale, lineCap: .round))
      for (i, point) in points.enumerated() {
        let circle = Path(ellipseIn: CGRect(x: point.x - ring, y: point.y - ring, width: ring * 2, height: ring * 2))
        if i == 1 { context.fill(circle, with: .color(.muster)) }
        context.stroke(circle, with: .color(.muster), lineWidth: 1.6 * scale)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// A round initial for an agent or person.
struct Monogram: View {
  var name: String
  var size: CGFloat = 20
  var body: some View {
    let hue = Double(abs(name.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }) % 360) / 360
    Text(String(name.prefix(1)).uppercased())
      .font(.system(size: size * 0.5, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(Color(hue: hue, saturation: 0.45, brightness: 0.62), in: Circle())
      .accessibilityHidden(true)
  }
}

enum Format {
  static func age(_ value: String) -> String {
    guard let date = Dates.parse(value) else { return "" }
    let formatter = RelativeDateTimeFormatter(); formatter.unitsStyle = .short; formatter.locale = Locale(identifier: "zh_CN")
    return Date().timeIntervalSince(date) < 45 ? "刚刚" : formatter.localizedString(for: date, relativeTo: Date())
  }
  static func time(_ value: String) -> String {
    guard let date = Dates.parse(value) else { return "" }
    return date.formatted(Calendar.current.isDateInToday(date) ? .dateTime.hour().minute() : .dateTime.month().day().hour().minute())
  }
  static func tokens(_ value: Int) -> String { value.formatted(.number.notation(.compactName).locale(Locale(identifier: "zh_CN"))) }
  static func duration(_ ms: Int) -> String {
    Duration.milliseconds(ms).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
  }
}

enum Runtimes {
  static let all: [(id: String, label: String)] = [
    ("codex", "Codex"), ("claude", "Claude Code"), ("pi", "pi"), ("omp", "omp"), ("gemini", "Gemini CLI"), ("opencode", "OpenCode"),
    ("qwen", "Qwen Code"), ("devin", "Devin"), ("cline", "Cline"), ("dsh", "dsh (DeepSeek)"), ("hermes", "Hermes Agent"),
    ("openclaw", "OpenClaw"), ("kiro", "Kiro CLI"), ("qoder", "Qoder CLI"), ("droid", "Droid"), ("auggie", "Auggie"), ("mock", "Mock"),
  ]
  static func label(_ id: String) -> String { all.first { $0.id == id }?.label ?? id }
  static func defaultModel(_ id: String) -> String { id == "mock" ? "mock" : "default" }
}

/// An inline, dismissable error that says what happened.
struct ErrorBanner: View {
  @Binding var message: String?
  var body: some View {
    if let message {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        Text(message).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        Button { self.message = nil } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("关闭")
      }
      .font(.callout)
      .padding(10)
      .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
  }
}
