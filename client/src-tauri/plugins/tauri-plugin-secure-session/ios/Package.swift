// swift-tools-version:5.9
import PackageDescription

// The product name must equal the crate name: tauri-plugin builds this package and links it by that name.
// The Tauri iOS API is copied to ../.tauri/tauri-api by the plugin's build script.
let package = Package(
  name: "tauri-plugin-secure-session",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-secure-session",
      type: .static,
      targets: ["tauri-plugin-secure-session"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-secure-session",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
