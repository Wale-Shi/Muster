import SwiftUI

struct DiffLine: Hashable {
  enum Kind { case add, remove, context, hunk, meta }
  var kind: Kind
  var text: String
  var old: Int?
  var new: Int?
}

struct DiffFile: Hashable, Identifiable {
  var id: Int
  var path: String
  var previousPath: String?
  var added = 0
  var removed = 0
  var binary = false
  var lines: [DiffLine] = []
}

/// Unified diff (`git diff`) split into files with line numbers.
enum Diff {
  private static func clean(_ path: String) -> String {
    var value = path
    if value.hasPrefix("\""), let data = value.data(using: .utf8), let decoded = try? JSONDecoder().decode(String.self, from: data) { value = decoded }
    if value.hasPrefix("a/") || value.hasPrefix("b/") { value.removeFirst(2) }
    return value
  }

  static func parse(_ content: String) -> [DiffFile] {
    var files: [DiffFile] = []
    var old = 0, new = 0, inHunk = false
    func current() -> Int? { files.indices.last }
    for text in content.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
      if text.hasPrefix("diff --git ") {
        let match = text.firstMatch(of: /^diff --git (".*?"|a\/.*?) (".*"|b\/.*)$/)
        files.append(DiffFile(id: files.count, path: clean(match.map { String($0.2) } ?? String(text.dropFirst(11)))))
        inHunk = false
        continue
      }
      if files.isEmpty && text.hasPrefix("--- ") { files.append(DiffFile(id: 0, path: clean(String(text.dropFirst(4))))) }
      guard let i = current() else { continue }
      if !inHunk && text.hasPrefix("--- ") { files[i].previousPath = clean(String(text.dropFirst(4))); continue }
      if !inHunk && text.hasPrefix("+++ ") {
        let path = clean(String(text.dropFirst(4)))
        files[i].path = path == "/dev/null" ? (files[i].previousPath ?? files[i].path) : path
        continue
      }
      if text.hasPrefix("rename from ") { files[i].previousPath = String(text.dropFirst(12)) }
      if text.hasPrefix("rename to ") { files[i].path = String(text.dropFirst(10)) }
      if text.hasPrefix("Binary files ") || text == "GIT binary patch" { files[i].binary = true }
      if let hunk = text.firstMatch(of: /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/) {
        old = Int(hunk.1) ?? 0; new = Int(hunk.2) ?? 0; inHunk = true
        files[i].lines.append(DiffLine(kind: .hunk, text: text))
      } else if inHunk && text.hasPrefix("+") {
        files[i].added += 1; files[i].lines.append(DiffLine(kind: .add, text: text, new: new)); new += 1
      } else if inHunk && text.hasPrefix("-") {
        files[i].removed += 1; files[i].lines.append(DiffLine(kind: .remove, text: text, old: old)); old += 1
      } else if inHunk && text.hasPrefix(" ") {
        files[i].lines.append(DiffLine(kind: .context, text: text, old: old, new: new)); old += 1; new += 1
      } else if !text.isEmpty {
        files[i].lines.append(DiffLine(kind: .meta, text: text))
      }
    }
    return files
  }
}

/// The task's changes: one version per completed build or revision.
struct ChangesInspector: View {
  @Environment(Store.self) private var store
  var detail: TodoDetail
  @State private var selection: String?
  @State private var filter = ""
  @State private var collapsed: Set<Int> = []

  private var versions: [(document: Document, label: String)] {
    let order = Dictionary(uniqueKeysWithValues: detail.builds.enumerated().map { ($1.id, $0) })
    return detail.builds.flatMap(\.documents).filter { $0.kind == "changes" }
      .sorted { (order[$0.buildId] ?? 0, $0.version) > (order[$1.buildId] ?? 0, $1.version) }
      .map { ($0, "第 \((order[$0.buildId] ?? 0) + 1) 次构建 · v\($0.version)") }
  }

  var body: some View {
    let versions = versions
    let selected = versions.first { $0.document.id == selection } ?? versions.first
    let files = selected.map { Diff.parse($0.document.content) } ?? []
    let visible = filter.isEmpty ? files : files.filter { $0.path.localizedCaseInsensitiveContains(filter) }
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text("变更").font(.headline)
        Spacer()
        if !versions.isEmpty {
          Picker("版本", selection: Binding(get: { selected?.document.id ?? "" }, set: { selection = $0 })) {
            ForEach(versions, id: \.document.id) { Text($0.label).tag($0.document.id) }
          }
          .labelsHidden().fixedSize()
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 10)
      if !files.isEmpty {
        HStack(spacing: 10) {
          Text("\(files.count) 个文件").foregroundStyle(.secondary)
          Text("+\(files.reduce(0) { $0 + $1.added })").foregroundStyle(.green)
          Text("−\(files.reduce(0) { $0 + $1.removed })").foregroundStyle(.red)
          Spacer()
          Button(collapsed.isEmpty ? "全部收起" : "全部展开") {
            collapsed = collapsed.isEmpty ? Set(files.map(\.id)) : []
          }.buttonStyle(.link)
        }
        .font(.callout.monospacedDigit())
        .padding(.horizontal, 14).padding(.bottom, 8)
        TextField("筛选文件", text: $filter).textFieldStyle(.roundedBorder).padding(.horizontal, 14).padding(.bottom, 8)
      }
      Divider()
      if files.isEmpty {
        ContentUnavailableView {
          Label(selected == nil ? "还没有变更" : "没有可显示的 diff", systemImage: "doc.text.magnifyingglass")
        } description: {
          Text(selected == nil ? "Agent 完成一次构建后，这里会显示每个改动文件的 diff。" : "这次构建的运行时没有提供 unified diff。")
        }
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            ForEach(visible) { file in
              Section {
                if !collapsed.contains(file.id) { FileBody(file: file) }
              } header: {
                FileHeader(file: file, collapsed: collapsed.contains(file.id)) {
                  if collapsed.contains(file.id) { collapsed.remove(file.id) } else { collapsed.insert(file.id) }
                }
              }
            }
          }
        }
      }
    }
    .onChange(of: versions.first?.document.id) { selection = nil }
  }
}

private struct FileHeader: View {
  var file: DiffFile
  var collapsed: Bool
  var toggle: () -> Void
  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right").rotationEffect(.degrees(collapsed ? 0 : 90)).font(.caption2).foregroundStyle(.secondary)
        Text(file.path).font(.system(.callout, design: .monospaced)).lineLimit(1).truncationMode(.head)
        Spacer(minLength: 8)
        Text("+\(file.added)").foregroundStyle(.green)
        Text("−\(file.removed)").foregroundStyle(.red)
      }
      .font(.caption.monospacedDigit())
      .padding(.horizontal, 14).padding(.vertical, 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(.bar)
    .help(file.previousPath.map { $0 != file.path && $0 != "/dev/null" ? "由 \($0) 重命名" : file.path } ?? file.path)
  }
}

private struct FileBody: View {
  var file: DiffFile
  var body: some View {
    if file.binary {
      Text("二进制文件已更改").font(.callout).foregroundStyle(.secondary).padding(14)
    } else {
      ScrollView(.horizontal, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
            HStack(spacing: 0) {
              Text(line.old.map(String.init) ?? "").frame(width: 38, alignment: .trailing).foregroundStyle(.tertiary)
              Text(line.new.map(String.init) ?? "").frame(width: 38, alignment: .trailing).foregroundStyle(.tertiary)
              Text(line.text.isEmpty ? " " : line.text).padding(.leading, 10).padding(.trailing, 14)
                .foregroundStyle(line.kind == .hunk || line.kind == .meta ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            }
            .font(.system(size: 11.5, design: .monospaced))
            .padding(.vertical, 0.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(line.kind == .add ? Color.green.opacity(0.12) : line.kind == .remove ? Color.red.opacity(0.12) : line.kind == .hunk ? Color.muster.opacity(0.07) : .clear)
          }
        }
        .textSelection(.enabled)
      }
      .padding(.bottom, 8)
    }
  }
}
