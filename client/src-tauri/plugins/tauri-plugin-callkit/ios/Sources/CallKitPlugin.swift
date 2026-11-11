import AVFoundation
import CallKit
import PushKit
import Tauri
import UIKit

/// The incoming call that has not been ended yet. Kept so a webview that starts after the user
/// answered from the lock screen can ask for it (`pending`) instead of missing the answer event.
private struct IncomingState {
  let uuid: UUID
  let channelId: String
  let name: String
  var answered: Bool
}

private struct CallArgs: Decodable {
  let channelId: String?
  let displayName: String?
  /// `end` only: true when the other side ended or declined, so CallKit is told instead of asked.
  let remote: Bool?
  let declined: Bool?
}

private struct Reply: Encodable {
  var supported = true
  var token: String?
  var pending: PendingCall?
}

private struct PendingCall: Encodable {
  let channelId: String
  let name: String
  let answered: Bool
}

/// One system call per Housecall 1:1 call. Everything below runs on the main queue: the
/// CXProvider and PushKit delegates are given the main queue, and commands hop to it.
class CallKitPlugin: Plugin, CXProviderDelegate, PKPushRegistryDelegate {
  private let provider: CXProvider
  private let controller = CXCallController()
  private var registry: PKPushRegistry?
  private var voipToken: String?
  private var uuidForChannel: [String: UUID] = [:]
  private var channelForUuid: [UUID: String] = [:]
  private var incoming: IncomingState?
  /// Calls this app asked to end itself; their end action is not echoed back to the web side.
  private var endedByApp = Set<UUID>()
  /// A ring nobody answers stops after this long (the server's push expires after 30 s).
  private let unansweredSeconds: Double = 45

  override init() {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = true
    configuration.maximumCallsPerCallGroup = 1
    configuration.includesCallsInRecents = true
    configuration.supportedHandleTypes = [.generic]
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: nil)
    // PushKit must be listening as soon as the app process exists: a VoIP push that launches the
    // app is delivered to the registry created here, before any web code has run.
    startPushKit()
  }

  // MARK: Commands (names match the strings the Rust side sends)

  @objc(register:)
  func registerCommand(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.startPushKit()
      invoke.resolve(Reply(token: self.voipToken))
    }
  }

  @objc(report_incoming:)
  func reportIncomingCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(CallArgs.self), let channelId = args.channelId else {
      return invoke.reject("channelId is required")
    }
    DispatchQueue.main.async {
      self.reportIncoming(channelId: channelId, name: args.displayName ?? "Housecall") { invoke.resolve(Reply()) }
    }
  }

  @objc(start_outgoing:)
  func startOutgoingCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(CallArgs.self), let channelId = args.channelId else {
      return invoke.reject("channelId is required")
    }
    DispatchQueue.main.async {
      if self.uuidForChannel[channelId] != nil { return invoke.resolve(Reply()) }
      let uuid = UUID()
      self.remember(uuid, channelId)
      self.configureAudio()
      let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: channelId))
      action.contactIdentifier = args.displayName
      action.isVideo = true
      self.controller.request(CXTransaction(action: action)) { error in
        DispatchQueue.main.async {
          if let error = error {
            self.forget(uuid)
            invoke.reject("Unable to start the call: \(error.localizedDescription)")
          } else {
            invoke.resolve(Reply())
          }
        }
      }
    }
  }

  @objc(connected:)
  func connectedCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(CallArgs.self), let channelId = args.channelId else {
      return invoke.reject("channelId is required")
    }
    DispatchQueue.main.async {
      if let uuid = self.uuidForChannel[channelId] {
        self.provider.reportOutgoingCall(with: uuid, connectedAt: Date())
      }
      invoke.resolve(Reply())
    }
  }

  @objc(end:)
  func endCommand(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(CallArgs.self), let channelId = args.channelId else {
      return invoke.reject("channelId is required")
    }
    DispatchQueue.main.async {
      guard let uuid = self.uuidForChannel[channelId] else { return invoke.resolve(Reply()) }
      if args.remote == true {
        self.provider.reportCall(with: uuid, endedAt: Date(), reason: args.declined == true ? .declinedElsewhere : .remoteEnded)
        self.forget(uuid)
        return invoke.resolve(Reply())
      }
      self.endedByApp.insert(uuid)
      self.controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
        DispatchQueue.main.async {
          if error != nil {
            // CallKit no longer knows this call; drop it so the next one starts clean.
            self.endedByApp.remove(uuid)
            self.forget(uuid)
          }
          invoke.resolve(Reply())
        }
      }
    }
  }

  @objc(pending:)
  func pendingCommand(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let state = self.incoming else { return invoke.resolve(Reply()) }
      invoke.resolve(Reply(pending: PendingCall(channelId: state.channelId, name: state.name, answered: state.answered)))
      // An answer is handed over once; later answers arrive as events.
      self.incoming?.answered = false
    }
  }

  // MARK: Reporting

  private func startPushKit() {
    guard registry == nil else { return }
    let created = PKPushRegistry(queue: .main)
    created.delegate = self
    created.desiredPushTypes = [.voIP]
    registry = created
  }

  private func remember(_ uuid: UUID, _ channelId: String) {
    uuidForChannel[channelId] = uuid
    channelForUuid[uuid] = channelId
  }

  private func forget(_ uuid: UUID) {
    if let channelId = channelForUuid.removeValue(forKey: uuid) { uuidForChannel.removeValue(forKey: channelId) }
    if incoming?.uuid == uuid { incoming = nil }
  }

  private func configureAudio() {
    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
  }

  private func emit(_ event: String, _ data: JSObject) {
    trigger(event, data: data)
  }

  /// Every VoIP push must end up here before its completion handler runs, or iOS stops delivering pushes.
  private func reportIncoming(channelId: String, name: String, completion: (() -> Void)? = nil) {
    let uuid = UUID()
    // A second ring for a conversation that is already ringing is reported and ended at once.
    let duplicate = uuidForChannel[channelId] != nil
    if !duplicate {
      remember(uuid, channelId)
      incoming = IncomingState(uuid: uuid, channelId: channelId, name: name, answered: false)
    }
    configureAudio()
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: channelId)
    update.localizedCallerName = name
    update.hasVideo = true
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportNewIncomingCall(with: uuid, update: update) { error in
      DispatchQueue.main.async {
        if duplicate && error == nil {
          self.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
        } else if error != nil && !duplicate {
          // iOS declined to show it (for example Do Not Disturb); the in-app toast is not used on iOS.
          self.forget(uuid)
        } else if !duplicate {
          DispatchQueue.main.asyncAfter(deadline: .now() + self.unansweredSeconds) {
            guard let state = self.incoming, state.uuid == uuid, !state.answered else { return }
            self.provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
            self.forget(uuid)
          }
        }
        completion?()
      }
    }
  }

  // MARK: PKPushRegistryDelegate

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = hex
    emit("voipToken", ["token": hex])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    if type == .voIP { voipToken = nil }
  }

  func pushRegistry(
    _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let info = payload.dictionaryPayload["housecall"] as? [String: Any]
    // Report something for every push, even a malformed one: iOS kills apps that do not.
    reportIncoming(
      channelId: (info?["channel_id"] as? String) ?? "unknown",
      name: (info?["from"] as? String) ?? "Housecall",
      completion: completion)
  }

  // MARK: CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    uuidForChannel.removeAll()
    channelForUuid.removeAll()
    incoming = nil
    endedByApp.removeAll()
    emit("reset", [:])
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    let update = CXCallUpdate()
    update.remoteHandle = action.handle
    update.localizedCallerName = action.contactIdentifier
    update.hasVideo = action.isVideo
    provider.reportCall(with: action.callUUID, updated: update)
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let channelId = channelForUuid[action.callUUID] else { return action.fail() }
    if incoming?.uuid == action.callUUID { incoming?.answered = true }
    emit("answer", ["channelId": channelId])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    if let channelId = channelForUuid[action.callUUID], !endedByApp.contains(action.callUUID) {
      emit("end", ["channelId": channelId])
    }
    endedByApp.remove(action.callUUID)
    forget(action.callUUID)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let channelId = channelForUuid[action.callUUID] {
      emit("mute", ["channelId": channelId, "muted": action.isMuted])
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    emit("audio", ["active": true])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    emit("audio", ["active": false])
  }
}

@_cdecl("init_plugin_callkit")
func initPlugin() -> Plugin {
  return CallKitPlugin()
}
