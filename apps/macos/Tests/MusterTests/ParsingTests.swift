import XCTest
@testable import Muster

final class ParsingTests: XCTestCase {
  func testDiffCountsAndLineNumbers() {
    let diff = """
    diff --git a/src/a.ts b/src/a.ts
    --- a/src/a.ts
    +++ b/src/a.ts
    @@ -1,2 +1,3 @@
     keep
    -old
    +new
    +more
    diff --git a/img.png b/img.png
    Binary files a/img.png and b/img.png differ
    """
    let files = Diff.parse(diff)
    XCTAssertEqual(files.map(\.path), ["src/a.ts", "img.png"])
    XCTAssertEqual(files[0].added, 2)
    XCTAssertEqual(files[0].removed, 1)
    XCTAssertEqual(files[0].lines.last?.new, 3)
    XCTAssertTrue(files[1].binary)
  }

  func testTaskDetailDecodesFlattenedTodo() throws {
    let json = #"{"id":"t1","number":3,"projectId":"p","title":"T","spec":"","phase":"review","agentId":null,"createdBy":"user","topicId":null,"previousGate":null,"createdAt":"2026-11-03T10:00:00.000Z","updatedAt":"2026-11-03T10:00:00.000Z","doneAt":null,"builds":[{"id":"b","todoId":"t1","branch":"muster/3","machineId":null,"status":"active","baseCommit":null,"headCommit":null,"tokensIn":1,"tokensOut":2,"durationMs":3,"createdAt":"x","turns":[],"documents":[]}]}"#
    let detail = try JSONDecoder().decode(TodoDetail.self, from: Data(json.utf8))
    XCTAssertEqual(detail.todo.phase, .review)
    XCTAssertEqual(detail.builds.first?.branch, "muster/3")
  }

  func testLiveLineTakesLastNonEmptyLine() {
    let message = Message(id: "m", conversationId: "c", turnId: nil, role: "agent", content: "first\n\n  running tests  \n", meta: [:], createdAt: "")
    let event = ServerEvent(type: "message.delta", todoId: "t", message: message)
    XCTAssertEqual(Store.liveLine(event)?.text, "running tests")
  }
}
