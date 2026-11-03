import Foundation

/// Follows `/api/events` (server-sent events), resuming from the last id after a drop.
final class EventStream: @unchecked Sendable {
  private let origin: URL
  private var task: Task<Void, Never>?

  init(origin: URL) { self.origin = origin }

  func start(onState: @escaping @MainActor (Bool) -> Void, onEvent: @escaping @MainActor (ServerEvent) -> Void) {
    task?.cancel()
    let url = origin.appending(path: "api/events")
    task = Task.detached {
      var lastId = ""
      let decoder = JSONDecoder()
      let config = URLSessionConfiguration.default
      config.timeoutIntervalForRequest = 60 * 60 * 24
      config.timeoutIntervalForResource = 60 * 60 * 24 * 365
      let session = URLSession(configuration: config)
      while !Task.isCancelled {
        do {
          var request = URLRequest(url: url)
          request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          if !lastId.isEmpty { request.setValue(lastId, forHTTPHeaderField: "Last-Event-ID") }
          let (bytes, response) = try await session.bytes(for: request)
          guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
          await onState(true)
          var id = "", data = ""
          for try await line in bytes.lines {
            if Task.isCancelled { break }
            // `lines` drops the blank separator, so a frame ends at the next `id:` or at a `data:` after data.
            if line.hasPrefix("id:") {
              if !data.isEmpty { await Self.deliver(data, decoder, onEvent); data = "" }
              id = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
              data += (data.isEmpty ? "" : "\n") + line.dropFirst(5).trimmingCharacters(in: .whitespaces)
              // Each server frame carries exactly one data line.
              await Self.deliver(data, decoder, onEvent); data = ""
              if !id.isEmpty { lastId = id }
            }
          }
        } catch {}
        await onState(false)
        if Task.isCancelled { return }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  private static func deliver(_ data: String, _ decoder: JSONDecoder, _ onEvent: @MainActor (ServerEvent) -> Void) async {
    guard let event = try? decoder.decode(ServerEvent.self, from: Data(data.utf8)) else { return }
    await onEvent(event)
  }

  func stop() { task?.cancel(); task = nil }
}
