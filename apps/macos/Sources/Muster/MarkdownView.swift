import SwiftUI
import AppKit
import Textual

/// Agent Markdown, rendered by Textual: real lists, tables, and syntax-highlighted code blocks.
struct MarkdownView: View {
  var text: String
  var body: some View {
    StructuredText(markdown: text)
      .textual.structuredTextStyle(.default)
      .textual.textSelection(.enabled)
      .environment(\.openURL, OpenURLAction { url in
        if url.isFileURL || url.scheme == nil && url.path.hasPrefix("/") { Files.open(url.path); return .handled }
        return url.scheme == "http" || url.scheme == "https" ? .systemAction : .discarded
      })
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
