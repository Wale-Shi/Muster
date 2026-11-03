import Foundation
import Darwin

/// Starts (or attaches to) the local Muster server and this machine's daemon, and stops them on quit.
@MainActor
final class Backend {
  let data: URL
  let logs: URL
  private(set) var origin = URL(string: "http://127.0.0.1:7420")!
  private var server: Process?
  private var daemon: Process?
  /// Called when a worker this app started exits on its own.
  var onWorkerExit: ((String, Int32) -> Void)?
  private var stopping = false

  init() {
    let env = ProcessInfo.processInfo.environment
    data = env["MUSTER_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".muster")
    logs = data.appending(path: "logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    let file = logs.appending(path: "desktop.log")
    if let handle = try? FileHandle(forWritingTo: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
    else { FileManager.default.createFile(atPath: file.path, contents: Data(line.utf8), attributes: [.posixPermissions: 0o600]) }
  }

  /// The checkout or bundled runtime that holds `apps/server/dist` and `apps/daemon/dist`.
  static func runtimeRoot() -> URL? {
    let fm = FileManager.default
    let ok = { (url: URL) in fm.fileExists(atPath: url.appending(path: "apps/server/dist/index.js").path) }
    if let bundled = Bundle.main.resourceURL?.appending(path: "runtime"), ok(bundled) { return bundled }
    if let root = ProcessInfo.processInfo.environment["MUSTER_ROOT"].map({ URL(fileURLWithPath: $0) }), ok(root) { return root }
    // `swift run` from apps/macos: walk up from the executable to the repository.
    var url = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
    for _ in 0..<8 { if ok(url) { return url }; url.deleteLastPathComponent() }
    return nil
  }

  /// PATH from the login shell, so CLIs installed by Homebrew, npm or nvm are found from a Finder launch.
  static func loginPath() async -> String {
    let env = ProcessInfo.processInfo.environment
    let output = await run(env["SHELL"] ?? "/bin/zsh", ["-ilc", "printf '\\n__MUSTER_PATH_BEGIN__%s__MUSTER_PATH_END__\\n' \"$PATH\""], timeout: 5)
    let shell = output.range(of: "__MUSTER_PATH_BEGIN__(.*?)__MUSTER_PATH_END__", options: .regularExpression)
      .map { String(output[$0]).replacingOccurrences(of: "__MUSTER_PATH_BEGIN__", with: "").replacingOccurrences(of: "__MUSTER_PATH_END__", with: "") } ?? ""
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    var seen = Set<String>()
    return (shell.split(separator: ":").map(String.init) + (env["PATH"] ?? "").split(separator: ":").map(String.init) + extra)
      .filter { $0.hasPrefix("/") && seen.insert($0).inserted }.joined(separator: ":")
  }

  private static func run(_ executable: String, _ args: [String], timeout: TimeInterval) async -> String {
    await withCheckedContinuation { continuation in
      let process = Process(); let pipe = Pipe()
      process.executableURL = URL(fileURLWithPath: executable); process.arguments = args
      process.standardOutput = pipe; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
      let resumed = NSLock(); var done = false
      let finish = { (value: String) in resumed.lock(); defer { resumed.unlock() }; if !done { done = true; continuation.resume(returning: value) } }
      process.terminationHandler = { _ in finish(String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)) }
      do { try process.run() } catch { finish(""); return }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if process.isRunning { process.terminate() }; finish("") }
    }
  }

  static func findNode(path: String, root: URL) -> String? {
    let fm = FileManager.default
    if let embedded = Bundle.main.resourceURL?.appending(path: "runtime/bin/node").path, fm.isExecutableFile(atPath: embedded) { return embedded }
    if let explicit = ProcessInfo.processInfo.environment["MUSTER_NODE"], fm.isExecutableFile(atPath: explicit) { return explicit }
    return path.split(separator: ":").map { "\($0)/node" }.first { fm.isExecutableFile(atPath: $0) }
  }

  struct Health: Decodable { var status: String?; var service: String? }
  static func isMuster(_ origin: URL) async -> Bool {
    var request = URLRequest(url: origin.appending(path: "health")); request.timeoutInterval = 0.8
    guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
          let health = try? JSONDecoder().decode(Health.self, from: data) else { return false }
    return health.status == "ok" && health.service == "muster"
  }

  static func portFree(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in(); addr.sin_family = sa_family_t(AF_INET); addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }
  }

  struct StartupError: LocalizedError { var errorDescription: String? }

  func start() async throws {
    log("Launching from \(Bundle.main.bundlePath)")
    guard let root = Self.runtimeRoot() else { throw StartupError(errorDescription: "找不到 Muster 运行时（apps/server/dist）。在仓库根目录运行 npm run build，或设置 MUSTER_ROOT。") }
    let path = await Self.loginPath()
    guard let node = Self.findNode(path: path, root: root) else { throw StartupError(errorDescription: "找不到 Node.js。请安装 Node.js 22 或更新版本，或用 MUSTER_NODE 指定 node 路径。") }
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = path; env["MUSTER_DATA_DIR"] = data.path; env["MUSTER_HOME"] = data.path
    let start = Int(env["MUSTER_DESKTOP_PORT"] ?? "") ?? 7420
    var attached = false
    for port in start..<(start + 50) {
      let candidate = URL(string: "http://127.0.0.1:\(port)")!
      if await Self.isMuster(candidate) { origin = candidate; attached = true; log("Attached to \(candidate)"); break }
      guard Self.portFree(port) else { continue }
      origin = candidate
      var serverEnv = env
      serverEnv["NODE_ENV"] = "production"; serverEnv["HOST"] = "127.0.0.1"; serverEnv["PORT"] = String(port); serverEnv["MUSTER_PUBLIC_URL"] = candidate.absoluteString
      let process = try spawn(node, [root.appending(path: "apps/server/dist/index.js").path], serverEnv, name: "server")
      server = process
      for _ in 0..<150 {
        if !process.isRunning { break }
        if await Self.isMuster(candidate) { break }
        try await Task.sleep(for: .milliseconds(100))
      }
      let ready = await Self.isMuster(candidate)
      if process.isRunning && ready { log("Started \(candidate)"); break }
      process.terminate(); server = nil
    }
    guard attached || server != nil else { throw StartupError(errorDescription: "Muster 服务没有启动成功，详见 \(logs.appending(path: "server.log").path)") }
    if try existingDaemon() { log("Reusing the running machine daemon") }
    else { daemon = try spawn(node, [root.appending(path: "apps/daemon/dist/index.js").path, "start", "--server", origin.absoluteString], env, name: "daemon") }
  }

  /// The CLI and the app share one daemon lock; never start a second claim loop for this machine.
  private func existingDaemon() throws -> Bool {
    guard let text = try? String(contentsOf: data.appending(path: "daemon.lock/pid"), encoding: .utf8), let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    guard kill(pid, 0) == 0 else { return false }
    struct Registration: Decodable { var server: String }
    if let registration = try? JSONDecoder().decode(Registration.self, from: Data(contentsOf: data.appending(path: "machine.json"))),
       registration.server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
      throw StartupError(errorDescription: "本机的 daemon 已连接到 \(registration.server)。先停止它，再连接 \(origin.absoluteString)。")
    }
    return true
  }

  private func spawn(_ node: String, _ args: [String], _ env: [String: String], name: String) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = args
    process.environment = env
    process.currentDirectoryURL = data
    let file = logs.appending(path: "\(name).log")
    if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    let handle = try FileHandle(forWritingTo: file); handle.seekToEndOfFile()
    process.standardOutput = handle; process.standardError = handle; process.standardInput = FileHandle.nullDevice
    process.terminationHandler = { [weak self] process in
      Task { @MainActor in
        guard let self, !self.stopping else { return }
        self.log("\(name) exited: \(process.terminationStatus)")
        self.onWorkerExit?(name, process.terminationStatus)
      }
    }
    try process.run()
    log("Started \(name) pid \(process.processIdentifier)")
    return process
  }

  /// This machine's id, once the daemon has enrolled.
  var machineId: String? {
    struct Registration: Decodable { var machineId: String }
    return try? JSONDecoder().decode(Registration.self, from: Data(contentsOf: data.appending(path: "machine.json"))).machineId
  }

  /// Daemon first (it reports interrupted turns to the server), then the server; each gets up to 10 seconds.
  /// Blocks, so call it off the main thread; `done` runs on the main thread.
  func stop(done: @escaping @Sendable () -> Void) {
    stopping = true
    log("Stopping workers")
    let processes = [daemon, server].compactMap { $0 }
    let logs = self.logs
    Thread.detachNewThread {
      for process in processes where process.isRunning {
        process.terminate()
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      }
      let line = "\(ISO8601DateFormatter().string(from: Date())) Workers stopped\n"
      if let handle = try? FileHandle(forWritingTo: logs.appending(path: "desktop.log")) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
      // While termination is pending AppKit spins the run loop in modal-panel mode only.
      RunLoop.main.perform(inModes: [.common, .modalPanel]) { done() }
    }
  }
}
