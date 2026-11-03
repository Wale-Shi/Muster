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
        Label("变更", systemImage: "plusminus.circle").font(.title3.weight(.semibold))
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
        TextField("筛选文件", text: $filter).textFieldStyle(.roundedBorder).controlSize(.large).padding(.horizontal, 14).padding(.bottom, 10)
      }
      Divider()
      if files.isEmpty {
        ContentUnavailableView {
          Label(selected == nil ? "还没有变更" : "没有可显示的 diff", systemImage: "doc.text.magnifyingglass")
        } description: {
          Text(selected == nil ? "Agent 完成一次构建后，这里会显示每个改动文件的 diff。" : "这次构建的运行时没有提供 unified diff。")
        }
        .frame(maxHeight: .infinity)
      } else {
        GeometryReader { geo in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
              ForEach(visible) { file in
                Section {
                  if !collapsed.contains(file.id) { FileBody(file: file, width: geo.size.width) }
                } header: {
                  FileHeader(file: file, collapsed: collapsed.contains(file.id)) {
                    withAnimation(.snappy(duration: 0.2)) { if collapsed.contains(file.id) { collapsed.remove(file.id) } else { collapsed.insert(file.id) } }
                  }
                }
              }
            }
          }
          .hardTopScrollEdge()
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
    let directory = (file.path as NSString).deletingLastPathComponent
    let name = (file.path as NSString).lastPathComponent
    let created = file.previousPath == "/dev/null", deleted = file.path == file.previousPath && file.lines.allSatisfy { $0.kind != .add } && file.removed > 0 && file.added == 0
    Button(action: toggle) {
      HStack(spacing: 8) {
        Image(systemName: "chevron.right").rotationEffect(.degrees(collapsed ? 0 : 90)).font(.caption2.weight(.semibold)).foregroundStyle(.tertiary).frame(width: 10)
        Image(systemName: Self.icon(name)).foregroundStyle(.secondary)
        (Text(directory.isEmpty ? "" : directory + "/").foregroundColor(.secondary) + Text(name).fontWeight(.semibold))
          .font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.head)
        if created { Tag(text: "新文件", tint: .green) }
        if deleted { Tag(text: "已删除", tint: .red) }
        Spacer(minLength: 8)
        DiffBar(added: file.added, removed: file.removed)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(.bar)
    .overlay(alignment: .bottom) { Divider() }
    .help(file.previousPath.map { $0 != file.path && $0 != "/dev/null" ? "由 \($0) 重命名" : file.path } ?? file.path)
  }

  static func icon(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "swift", "ts", "tsx", "js", "jsx", "py", "go", "rs", "rb", "java", "kt", "c", "cc", "cpp", "h", "m": return "chevron.left.forwardslash.chevron.right"
    case "md", "txt": return "doc.plaintext"
    case "json", "yml", "yaml", "toml", "plist": return "curlybraces"
    case "css", "scss": return "paintbrush"
    case "png", "jpg", "jpeg", "gif", "svg", "webp": return "photo"
    default: return "doc"
    }
  }
}

/// Added and removed counts with a five-block bar, like a pull request.
private struct DiffBar: View {
  var added: Int
  var removed: Int
  var body: some View {
    let total = max(added + removed, 1)
    let green = added == 0 ? 0 : max(1, Int((Double(added) / Double(total) * 5).rounded()))
    let red = removed == 0 ? 0 : min(5 - green, max(1, 5 - green))
    HStack(spacing: 6) {
      Text("+\(added)").foregroundStyle(.green)
      Text("−\(removed)").foregroundStyle(.red)
      HStack(spacing: 1.5) {
        ForEach(0..<5, id: \.self) { i in
          RoundedRectangle(cornerRadius: 1.5).fill(i < green ? Color.green : i < green + red ? Color.red : Color.secondary.opacity(0.25)).frame(width: 7, height: 7)
        }
      }
    }
    .font(.caption.monospacedDigit().weight(.medium))
  }
}

private struct FileBody: View {
  var file: DiffFile
  var width: CGFloat
  var body: some View {
    if file.binary {
      Label("二进制文件已更改", systemImage: "doc.zipper").font(.callout).foregroundStyle(.secondary).padding(14)
    } else {
      ScrollView(.horizontal, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(file.lines.enumerated()), id: \.offset) { _, line in
            if line.kind == .hunk {
              Text(line.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.muster)
                .padding(.leading, 14).padding(.vertical, 4)
                .frame(minWidth: width, alignment: .leading)
                .background(Color.muster.opacity(0.08))
            } else {
              HStack(spacing: 0) {
                Text(line.old.map(String.init) ?? "").frame(width: 36, alignment: .trailing).foregroundStyle(.tertiary)
                Text(line.new.map(String.init) ?? "").frame(width: 36, alignment: .trailing).foregroundStyle(.tertiary)
                Text(line.kind == .add ? "+" : line.kind == .remove ? "−" : " ").frame(width: 18).foregroundStyle(line.kind == .add ? .green : .red)
                Text(line.text.isEmpty ? " " : String(line.text.dropFirst())).padding(.trailing, 16)
                  .foregroundStyle(line.kind == .meta ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
              }
              .font(.system(size: 11.5, design: .monospaced))
              .padding(.vertical, 1)
              .frame(minWidth: width, alignment: .leading)
              .background(line.kind == .add ? Color.green.opacity(0.13) : line.kind == .remove ? Color.red.opacity(0.13) : .clear)
            }
          }
        }
        .textSelection(.enabled)
      }
      .padding(.bottom, 10)
    }
  }
}
