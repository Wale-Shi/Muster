// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "Muster",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "Muster", path: "Sources/Muster", swiftSettings: [.enableUpcomingFeature("BareSlashRegexLiterals")]),
    .testTarget(name: "MusterTests", dependencies: ["Muster"], path: "Tests/MusterTests"),
  ]
)
