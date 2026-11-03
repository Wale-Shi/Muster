import SwiftUI
import AppKit

/// Block-level Markdown (headings, lists, quotes, fenced code, rules) with inline styling from Foundation.
struct MarkdownView: View {
  var text: String

  enum Block: Hashable {
    case paragraph(String), heading(Int, String), bullet(String, Int, String?), quote(String), code(String, String), rule
  }

  static func blocks(_ text: String) -> [Block] {
    var blocks: [Block] = [], paragraph: [String] = []
    var code: (lang: String, lines: [String])?
    func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
    for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if var open = code {
        if line.hasPrefix("```") { blocks.append(.code(open.lang, open.lines.joined(separator: "\n"))); code = nil }
        else { open.lines.append(raw); code = open }
        continue
      }
      if line.hasPrefix("```") { flush(); code = (String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces), []); continue }
      if line.isEmpty { flush(); continue }
      if let match = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) { flush(); blocks.append(.heading(match.1.count, String(match.2))); continue }
      if line.wholeMatch(of: /(-{3,}|\*{3,}|_{3,})/) != nil { flush(); blocks.append(.rule); continue }
      if line.hasPrefix(">") { flush(); blocks.append(.quote(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))); continue }
      let indent = raw.prefix { $0 == " " }.count / 2
      if let match = line.firstMatch(of: /^[-*+]\s+(\[[ xX]\]\s+)?(.*)$/) {
        flush()
        let box = match.1.map { $0.lowercased().contains("x") ? "☑" : "☐" }
        blocks.append(.bullet(String(match.2), indent, box ?? "•")); continue
      }
      if let match = line.firstMatch(of: /^(\d+)[.)]\s+(.*)$/) { flush(); blocks.append(.bullet(String(match.2), indent, "\(match.1).")); continue }
      paragraph.append(line)
    }
    if let open = code { blocks.append(.code(open.lang, open.lines.joined(separator: "\n"))) }
    flush()
    return blocks
  }

  static func inline(_ text: String) -> AttributedString {
    var value = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    for run in value.runs where run.inlinePresentationIntent?.contains(.code) == true {
      value[run.range].font = .system(.body, design: .monospaced).weight(.regular)
      value[run.range].backgroundColor = Color.secondary.opacity(0.12)
    }
    return value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text): Text(Self.inline(text)).fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
          Text(Self.inline(text)).font(level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold)).padding(.top, 4)
        case .bullet(let text, let indent, let marker):
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(marker ?? "•").foregroundStyle(.secondary).monospacedDigit()
            Text(Self.inline(text)).fixedSize(horizontal: false, vertical: true)
          }.padding(.leading, CGFloat(indent) * 14)
        case .quote(let text):
          Text(Self.inline(text)).foregroundStyle(.secondary).padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 3) }
        case .code(_, let code): CodeBlock(code: code)
        case .rule: Divider()
        }
      }
    }
    .textSelection(.enabled)
    .environment(\.openURL, OpenURLAction { url in
      if url.isFileURL || url.scheme == nil && url.path.hasPrefix("/") { Files.open(url.path); return .handled }
      return url.scheme == "http" || url.scheme == "https" ? .systemAction : .discarded
    })
  }
}

struct CodeBlock: View {
  var code: String
  @State private var copied = false
  var body: some View {
    ScrollView(.horizontal) {
      Text(code).font(.system(.callout, design: .monospaced)).padding(10).fixedSize()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    .overlay(alignment: .topTrailing) {
      Button { Clipboard.copy(code); copied = true } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
        .buttonStyle(.borderless).padding(6).help("复制代码")
    }
  }
}

enum Clipboard {
  static func copy(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
}

enum Files {
  /// Paths come from agent output, so anything runnable is revealed in Finder instead of opened.
  static func open(_ path: String) {
    let url = URL(fileURLWithPath: path)
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &directory) else { return }
    let runnable = directory.boolValue ? url.pathExtension == "app" : FileManager.default.isExecutableFile(atPath: path) || ["app", "command", "sh", "pkg", "dmg", "terminal", "workflow"].contains(url.pathExtension)
    if runnable { NSWorkspace.shared.activateFileViewerSelecting([url]) } else { NSWorkspace.shared.open(url) }
  }
}
