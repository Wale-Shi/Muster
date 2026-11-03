// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Muster",
  platforms: [.macOS(.v15)],
  dependencies: [
    // Markdown and syntax-highlighted code rendering on SwiftUI's Text pipeline (successor to MarkdownUI).
    .package(url: "https://github.com/gonzalezreal/textual", from: "0.5.0"),
  ],
  targets: [
    .executableTarget(
      name: "Muster",
      dependencies: [.product(name: "Textual", package: "textual")],
      path: "Sources/Muster",
      swiftSettings: [.enableUpcomingFeature("BareSlashRegexLiterals")]
    ),
    .testTarget(name: "MusterTests", dependencies: ["Muster"], path: "Tests/MusterTests"),
  ],
  swiftLanguageModes: [.v5]
)
