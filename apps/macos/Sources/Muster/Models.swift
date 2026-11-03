import Foundation

/// Arbitrary JSON, for message metadata and event payloads.
enum JSONValue: Codable, Hashable, Sendable {
  case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  subscript(key: String) -> JSONValue? { if case .object(let o) = self { o[key] } else { nil } }
  var string: String? { if case .string(let v) = self { v } else { nil } }
  var number: Double? { if case .number(let v) = self { v } else { nil } }
  var bool: Bool? { if case .bool(let v) = self { v } else { nil } }
  /// Compact text for tool inputs and outputs.
  var display: String {
    switch self {
    case .string(let v): return v
    case .null: return ""
    default:
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? ""
    }
  }
}

enum Phase: String, Codable, CaseIterable, Sendable {
  case todo, queued, building, review, failed, done, closed
  var running: Bool { self == .queued || self == .building }
  var needsYou: Bool { self == .review || self == .failed }
}

struct Project: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var name: String
  var repoUrl: String
  var baseBranch: String
  var chiefAgentId: String?
  var topicId: String
  var description: String?
  var createdAt: String
}

struct AgentPermissions: Codable, Hashable, Sendable { var createSkills: Bool; var updateSkills: Bool }

struct Agent: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var name: String
  var role: String
  var runtime: String
  var model: String
  var reasoning: String?
  var isChief: Bool
  var permissions: AgentPermissions?
  var defaultSkillIds: [String]?
  var connectionIds: [String]?
  var createdAt: String
}

struct AgentProfile: Codable, Sendable {
  var inProgress: [Todo]
  var workspaces: [Project]
}

struct RuntimeModel: Codable, Hashable, Sendable { var id: String; var name: String?; var reasoning: [String]? }
struct RuntimeModels: Codable, Hashable, Sendable { var models: [RuntimeModel]; var error: String?; var checkedAt: String }

struct Machine: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var name: String
  var concurrency: Int
  var runtimes: [String]
  var models: [String: RuntimeModels]?
  var lastSeenAt: String?
  var online: Bool?
  var running: Int?
}

struct Todo: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var number: Int
  var projectId: String
  var title: String
  var spec: String
  var phase: Phase
  var agentId: String?
  var createdBy: String
  var createdAt: String
  var updatedAt: String
  var doneAt: String?
}

struct Turn: Codable, Identifiable, Hashable, Sendable {
  struct AgentSnapshot: Codable, Hashable, Sendable { var name: String; var runtime: String; var model: String }
  var id: String
  var kind: String
  var status: String
  var startedAt: String?
  var endedAt: String?
  var error: String?
  var tokensIn: Int
  var tokensOut: Int
  var sessionId: String?
  var agent: AgentSnapshot?
}

struct Document: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var buildId: String
  var kind: String
  var version: Int
  var content: String
  var createdAt: String
}

struct Build: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var branch: String
  var status: String
  var tokensIn: Int
  var tokensOut: Int
  var durationMs: Int
  var turns: [Turn]
  var documents: [Document]
}

/// A task with its builds, turns and diffs.
struct TodoDetail: Codable, Sendable {
  var todo: Todo
  var builds: [Build]
  init(from decoder: Decoder) throws {
    todo = try Todo(from: decoder)
    builds = try decoder.container(keyedBy: Keys.self).decode([Build].self, forKey: .builds)
  }
  func encode(to encoder: Encoder) throws {
    try todo.encode(to: encoder)
    var c = encoder.container(keyedBy: Keys.self); try c.encode(builds, forKey: .builds)
  }
  private enum Keys: String, CodingKey { case builds }
}

struct Message: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var conversationId: String
  var turnId: String?
  var role: String
  var content: String
  var meta: [String: JSONValue]
  var createdAt: String
  var revision: Double { meta["revision"]?.number ?? 0 }
  var streaming: Bool { meta["streaming"]?.bool == true }
}

struct QueuedMessage: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var content: String
  var delivering: Bool
}

struct Topic: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var activity: String
}

struct UsageRow: Codable, Hashable, Sendable {
  var day: String
  var agentId: String?
  var agentName: String
  var runtime: String
  var model: String
  var projectId: String?
  var tokensIn: Int
  var tokensOut: Int
  var durationMs: Int
  var turns: Int
}

struct NotificationPreferences: Codable, Hashable, Sendable {
  var review = true, failed = true, done = true, dockBadge = true
}
struct WorkspaceSettings: Codable, Hashable, Sendable {
  var workspaceName: String
  var notifications: NotificationPreferences
}

struct ApiKey: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var name: String
  var prefix: String
  var scopes: [String]
  var createdAt: String
  var lastUsedAt: String?
  var revokedAt: String?
}

struct Skill: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var slug: String
  var name: String
  var description: String
}

struct Connection: Codable, Identifiable, Hashable, Sendable {
  var id: String
  var name: String
  var identifier: String
  var transport: String
  var url: String?
  var command: String?
}

struct ServerEvent: Decodable, Sendable {
  var id: String?
  var type: String
  var turnId: String?
  var todoId: String?
  var conversationId: String?
  var message: Message?
  var payload: JSONValue?
}

enum Dates {
  nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
  }()
  nonisolated(unsafe) private static let plain = ISO8601DateFormatter()
  static func parse(_ value: String?) -> Date? {
    guard let value else { return nil }
    return fractional.date(from: value) ?? plain.date(from: value)
  }
}
