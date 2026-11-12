import Foundation
import Security
import Tauri

private struct Args: Decodable {
  let origin: String?
  /// `set` only: the session as a JSON string. Rust has already reduced it to the four known fields.
  let session: String?
}

private struct Reply: Encodable {
  var session: String?
  var origins: [String]?
  var ok: Bool?
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
