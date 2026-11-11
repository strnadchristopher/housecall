// swift-tools-version:5.9
import PackageDescription

// The product name must equal the crate name: tauri-plugin builds this package and links it by that name.
// The Tauri iOS API is copied to ../.tauri/tauri-api by the plugin's build script.
let package = Package(
  name: "tauri-plugin-callkit",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-callkit",
      type: .static,
      targets: ["tauri-plugin-callkit"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-callkit",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
