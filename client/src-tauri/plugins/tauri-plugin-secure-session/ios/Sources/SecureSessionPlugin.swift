import UIKit
import Foundation
import Security
import LocalAuthentication
import Tauri

private struct Args: Decodable {
  let enabled: Bool?
  let origin: String?
  /// `set` only: the session as a JSON string. Rust has already reduced it to the four known fields.
  let session: String?
  let account: String?
  let value: String?
  let reason: String?
}

private struct SurfaceReply: Encodable { let ok: Bool; let captured: Bool }

private struct Reply: Encodable {
  var session: String?
  var value: String?
  var origins: [String]?
  var ok: Bool?
  var supported: Bool?
  var verified: Bool?
}

/// The Housecall session in the iOS Keychain: one generic password per server origin.
/// Available after the first unlock, never synchronized to iCloud, never restored onto another device.
class SecureSessionPlugin: Plugin {
  private let service = "com.mapleavenuelabs.housecall.session"
  private let queue = DispatchQueue(label: "housecall.secure-session")

  private func query(_ account: String? = nil) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: false,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  @objc(get:)
  func getCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let origin = args.origin else {
      return invoke.reject("origin is required")
    }
    queue.async {
      var request = self.query(origin)
      request[kSecReturnData as String] = true
      request[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let status = SecItemCopyMatching(request as CFDictionary, &item)
      if status == errSecItemNotFound { return invoke.resolve(Reply()) }
      guard status == errSecSuccess, let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
        return invoke.reject("secure storage unavailable")
      }
      invoke.resolve(Reply(session: text))
    }
  }

  @objc(set:)
  func setCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let origin = args.origin, let session = args.session,
      let data = session.data(using: .utf8)
    else {
      return invoke.reject("origin and session are required")
    }
    queue.async {
      let update = SecItemUpdate(
        self.query(origin) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
      if update == errSecSuccess { return invoke.resolve(Reply(ok: true)) }
      var add = self.query(origin)
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
        return invoke.reject("secure storage unavailable")
      }
      invoke.resolve(Reply(ok: true))
    }
  }

  @objc(remove:)
  func removeCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let origin = args.origin else {
      return invoke.reject("origin is required")
    }
    queue.async {
      let status = SecItemDelete(self.query(origin) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        return invoke.reject("secure storage unavailable")
      }
      invoke.resolve(Reply(ok: true))
    }
  }

  // Separate service keeps identity records out of session enumeration/removal.
  private func recordQuery(_ account: String) -> [String: Any] {
    var q = query(account)
    q[kSecAttrService as String] = "com.mapleavenuelabs.housecall.identity"
    return q
  }
  @objc(recordGet:)
  func recordGet(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let account = args.account else { return invoke.reject("invalid record") }
    queue.async {
      var q = self.recordQuery(account)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let status = SecItemCopyMatching(q as CFDictionary, &item)
      if status == errSecItemNotFound { return invoke.resolve(Reply()) }
      guard status == errSecSuccess, let data = item as? Data, let text = String(data: data, encoding: .utf8) else { return invoke.reject("secure storage unavailable") }
      invoke.resolve(Reply(value: text))
    }
  }
  @objc(recordSet:)
  func recordSet(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let account = args.account, let value = args.value,
      let data = value.data(using: .utf8) else { return invoke.reject("invalid record") }
    queue.async {
      let q = self.recordQuery(account)
      let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
      if status == errSecSuccess { return invoke.resolve(Reply(ok: true)) }
      guard status == errSecItemNotFound else { return invoke.reject("secure storage unavailable") }
      var add = q
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return invoke.reject("secure storage unavailable") }
      invoke.resolve(Reply(ok: true))
    }
  }
  @objc(recordRemove:)
  func recordRemove(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let account = args.account else { return invoke.reject("invalid record") }
    queue.async {
      let status = SecItemDelete(self.recordQuery(account) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { return invoke.reject("secure storage unavailable") }
      invoke.resolve(Reply(ok: true))
    }
  }

  private var captureCover: UIView?
  private var captureObserver: NSObjectProtocol?
  private var inactiveObserver: NSObjectProtocol?
  private var activeObserver: NSObjectProtocol?
  private var sensitive = false
  private func updateCaptureCover() {
    guard let window = self.manager.viewController?.view.window else { return }
    let hidden = sensitive && (window.screen.isCaptured || UIApplication.shared.applicationState != .active)
    if hidden && captureCover == nil {
      let cover = UIView(frame: window.bounds)
      cover.backgroundColor = .black
      cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      cover.isUserInteractionEnabled = true
      window.addSubview(cover); captureCover = cover
    } else if !hidden { captureCover?.removeFromSuperview(); captureCover = nil }
  }
  @objc(sensitiveSurface:)
  func sensitiveSurface(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let enabled = args.enabled else { return invoke.reject("invalid screen protection request") }
    DispatchQueue.main.async {
      self.sensitive = enabled
      if enabled && self.captureObserver == nil {
        self.captureObserver = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.updateCaptureCover() }
        self.inactiveObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
          guard let self, self.sensitive, let window = self.manager.viewController?.view.window else { return }
          if self.captureCover == nil { let cover = UIView(frame: window.bounds); cover.backgroundColor = .black; cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]; window.addSubview(cover); self.captureCover = cover }
        }
        self.activeObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateCaptureCover() }
      }
      if !enabled {
        for observer in [self.captureObserver, self.inactiveObserver, self.activeObserver] { if let observer { NotificationCenter.default.removeObserver(observer) } }
        self.captureObserver = nil; self.inactiveObserver = nil; self.activeObserver = nil
      }
      self.updateCaptureCover()
      invoke.resolve(SurfaceReply(ok: true, captured: self.manager.viewController?.view.window?.screen.isCaptured ?? true))
    }
  }

  @objc(verifyOwner:)
  func verifyOwner(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(Args.self), let reason = args.reason else { return invoke.reject("invalid verification reason") }
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      if error?.code == LAError.passcodeNotSet.rawValue { return invoke.resolve(Reply(supported: false, verified: false)) }
      return invoke.reject("device verification unavailable")
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
      invoke.resolve(Reply(supported: true, verified: success))
    }
  }

  @objc(list:)
  func listCommand(_ invoke: Invoke) {
    queue.async {
      var request = self.query()
      request[kSecReturnAttributes as String] = true
      request[kSecMatchLimit as String] = kSecMatchLimitAll
      var items: CFTypeRef?
      let status = SecItemCopyMatching(request as CFDictionary, &items)
      if status == errSecItemNotFound { return invoke.resolve(Reply(origins: [])) }
      guard status == errSecSuccess, let rows = items as? [[String: Any]] else {
        return invoke.reject("secure storage unavailable")
      }
      // Most recently modified first, so the first origin is the account used last.
      let sorted = rows.sorted {
        (($0[kSecAttrModificationDate as String] as? Date) ?? .distantPast)
          > (($1[kSecAttrModificationDate as String] as? Date) ?? .distantPast)
      }
      invoke.resolve(Reply(origins: sorted.compactMap { $0[kSecAttrAccount as String] as? String }))
    }
  }
}

@_cdecl("init_plugin_secure_session")
func initPlugin() -> Plugin {
  return SecureSessionPlugin()
}
