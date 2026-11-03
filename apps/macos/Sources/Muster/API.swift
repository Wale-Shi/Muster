import Foundation

struct APIError: LocalizedError {
  var message: String
  var status: Int
  var errorDescription: String? { message }
}

/// The server's REST API. Every response is `{ data }` or `{ error }`.
struct API: Sendable {
  var origin: URL

  private struct Envelope<T: Decodable>: Decodable { var data: T }
  private struct Failure: Decodable { var error: String }
  struct Empty: Decodable {}

  func request<T: Decodable>(_ path: String, _ method: String = "GET", body: (any Encodable)? = nil, as: T.Type = T.self) async throws -> T {
    var request = URLRequest(url: URL(string: "/api\(path)", relativeTo: origin)!)
    request.httpMethod = method
    request.timeoutInterval = 30
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    } else if method != "GET" && method != "DELETE" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data("{}".utf8)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 204 || T.self == Empty.self && (200..<300).contains(status) { return Empty() as! T }
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "请求失败（HTTP \(status)）"
      throw APIError(message: message, status: status)
    }
    do { return try JSONDecoder().decode(Envelope<T>.self, from: data).data }
    catch { throw APIError(message: "无法读取服务器响应：\(error.localizedDescription)", status: status) }
  }

  private static func id(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? value }

  func projects() async throws -> [Project] { try await request("/projects") }
  func todos() async throws -> [Todo] { try await request("/todos") }
  func agents() async throws -> [Agent] { try await request("/agents") }
  func machines() async throws -> [Machine] { try await request("/machines") }
  func todo(_ id: String) async throws -> TodoDetail { try await request("/todos/\(Self.id(id))") }
  func topic(_ id: String) async throws -> Topic { try await request("/topics/\(Self.id(id))") }
  func messages(_ conversation: String) async throws -> [Message] { try await request("/conversations/\(Self.id(conversation))/messages") }
  func queued(_ conversation: String) async throws -> [QueuedMessage] { try await request("/conversations/\(Self.id(conversation))/queued-messages") }
  func retractQueued(_ conversation: String, _ message: String) async throws {
    _ = try await request("/conversations/\(Self.id(conversation))/queued-messages/\(Self.id(message))", "DELETE", as: Empty.self)
  }
  func usage(days: Int?) async throws -> [UsageRow] { try await request(days.map { "/usage?days=\($0)" } ?? "/usage") }
  func settings() async throws -> WorkspaceSettings { try await request("/settings") }
  func saveSettings(_ patch: [String: JSONValue]) async throws -> WorkspaceSettings { try await request("/settings", "PATCH", body: patch) }
  func apiKeys() async throws -> [ApiKey] { try await request("/api-keys") }
  func skills() async throws -> [Skill] { try await request("/skills") }
  func connections() async throws -> [Connection] { try await request("/connections") }
  func agentProfile(_ id: String) async throws -> AgentProfile { try await request("/agents/\(Self.id(id))") }

  struct NewTodo: Encodable { var projectId: String; var title: String; var spec: String; var agentId: String?; var start: Bool }
  func createTodo(_ input: NewTodo) async throws -> Todo { try await request("/todos", "POST", body: input) }

  struct NewProject: Encodable { var name: String; var repoUrl: String; var baseBranch: String; var chiefAgentId: String? }
  func createProject(_ input: NewProject) async throws -> Project { try await request("/projects", "POST", body: input) }
  func updateProject(_ id: String, _ patch: [String: JSONValue]) async throws -> Project { try await request("/projects/\(Self.id(id))", "PATCH", body: patch) }
  func deleteProject(_ id: String) async throws { _ = try await request("/projects/\(Self.id(id))", "DELETE", as: Empty.self) }

  struct AgentInput: Encodable { var name: String; var role: String; var runtime: String; var model: String; var reasoning: String? }
  func createAgent(_ input: AgentInput) async throws -> Agent { try await request("/agents", "POST", body: input) }
  func updateAgent(_ id: String, _ patch: [String: JSONValue]) async throws -> Agent { try await request("/agents/\(Self.id(id))", "PATCH", body: patch) }
  func deleteAgent(_ id: String) async throws { _ = try await request("/agents/\(Self.id(id))", "DELETE", as: Empty.self) }

  enum Action: String { case start, done, rerun, stop, close, reopen }
  func act(_ todo: String, _ action: Action, _ input: [String: JSONValue] = [:]) async throws {
    _ = try await request("/todos/\(Self.id(todo))/\(action.rawValue)", "POST", body: input, as: JSONValue.self)
  }
  func sendTodo(_ todo: String, _ content: String) async throws {
    _ = try await request("/todos/\(Self.id(todo))/message", "POST", body: ["content": content], as: JSONValue.self)
  }
  func sendTopic(_ topic: String, _ content: String) async throws {
    _ = try await request("/topics/\(Self.id(topic))/messages", "POST", body: ["content": content], as: JSONValue.self)
  }
  func refreshModels() async throws { _ = try await request("/machines/refresh-models", "POST", as: JSONValue.self) }

  struct NewKey: Encodable { var name: String; var scopes: [String] }
  struct CreatedKey: Decodable { var key: String }
  func createKey(_ input: NewKey) async throws -> String { try await request("/api-keys", "POST", body: input, as: CreatedKey.self).key }
  func revokeKey(_ id: String) async throws { _ = try await request("/api-keys/\(Self.id(id))", "DELETE", as: Empty.self) }
}
