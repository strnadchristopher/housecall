# Android native push candidate

The Android client contains a native Tauri command bridge, FirebaseMessagingService and WorkManager reconciliation worker. Android builds without Firebase client configuration; push remains unavailable until the app builder supplies it. There is no APNs implementation. This document describes the implementation candidate, not a live-device delivery receipt.

## Opt-in and frontend hooks

`client/src/transport/nativePush.ts` exports:

- `nativePushStatus()` returns supported/configured/enabled/permissionGranted. It performs no permission request or registration. Unsupported desktop, browser and Apple targets return false.
- `enableNativePush(origin, session)` must be called only after an explicit background-notification opt-in. It requests Android 13+ notification permission and stores the current bearer/device-key pair encrypted by Android Keystore. HTTPS origin only; no URLs containing credentials, path, query or fragment. It resolves after durable work is scheduled; this is not a provider registration or delivery receipt.
- `reconcileNativePush()` schedules authenticated reconciliation after reconnect/resume. `MainActivity.onResume`, FCM messages/token refresh/deleted-message notifications, and periodic WorkManager work also schedule it without the WebView.
- `clearNativePush()` must be awaited before account replacement and before server logout/session revocation. It invalidates pending permission/enable callbacks, deletes encrypted session and ledger plus Keystore key, cancels this subsystem's OS notifications and jobs, disables automatic token generation, then queues best-effort backend unregister and Firebase token deletion. The command resolves after local cleanup, without waiting for those network operations. Cleanup is queued before subsequent enable work to preserve token-deletion ordering. Local erasure does not depend on network success. The App must not suppress a native-clear error and continue account switching as though cleanup succeeded.

The parent integrates these hooks through the existing notification intents and authentication lifecycle; enable is never called automatically on login. Native plugin errors use a finite safe-message allowlist before reaching the frontend. The background credential grant is separate from the existing memory-only WebView login. Closing/reloading the WebView keeps the explicit native grant until logout/revocation. A new account cannot replace it without clear. No API exposes native stored credentials to the frontend.

## Build configuration

Supply these public client identifiers to the Android app build environment, from the Firebase Android app registered with package `com.littleobelisk.chriscord`:

```
CHRISCORD_FIREBASE_APPLICATION_ID
CHRISCORD_FIREBASE_API_KEY
CHRISCORD_FIREBASE_PROJECT_ID
CHRISCORD_FIREBASE_SENDER_ID
```

They are compiled as BuildConfig values; all four must be nonempty. They are Firebase client configuration, not the server's FCM service-account private key. No `google-services.json`, service-account file or host credentials are read. No identifiers have been invented. Firebase Messaging uses the pinned BoM 35.0.2; Analytics is not a dependency, and analytics collection plus FCM auto-init default to disabled. Automatic token generation is enabled only after opt-in. The backend must separately enable its FCM provider with matching project credentials as documented in PUSH.md.

Changing these values changes the APK and requires rebuilding. Reinitializing the generated Android project can overwrite native integration: retain/review these tracked changes when running `tauri android init` again.

## Reconciliation and security

Provider payloads are ignored as content and used only to schedule work. The worker obtains the real SDK token and registers it through authenticated `PUT /api/push/device`. It retrieves at most 100 authenticated `/api/push/events`, validates operation/epoch agreement, applies retracts first, then retrieves at most 500 `/api/notifications`. The latter endpoint checks current channel membership and uses a message foreign key that cascades on unsend. Alerts require an exact current message/channel notification pair. Missing or truncated data never authorizes an alert. Existing OS inventory is checked on every pass, so omitted/inaccessible/deleted notifications are removed conservatively, even when outbox history has overflowed. No chat text or names are fetched or shown: the OS displays only “Chriscord / You have a new mention”.

Each session has a random generation. Every local state update rechecks it under the same lock used by logout. Requests use captured credentials only, reject redirects, disable HTTP proxies, require HTTPS, bound response bytes to 1 MiB and use timeouts. A late response cannot persist state or post a notification for another generation. Authentication/membership rejection clears the grant. Network failure suppresses new alerts and retries; it is not evidence of delivery or removal.

The encrypted AtomicFile in Android's no-backup directory contains session credentials and a per-message replay ledger. Its AES-GCM key is generated by Android Keystore; keys are not exported. Hardware backing depends on device support and is not asserted. Application backup is disabled. Tombstones are persisted before notification cancellation and acknowledgement; epoch 1 always beats later epoch 0. A prior display remains recorded even after the user dismisses it, preventing duplicate reappearance. The 4096-entry ledger never evicts tombstones: at capacity it suppresses new alerts until the grant is cleared. Retracts still cancel OS notifications and are acknowledged. OS-disabled alerts are deferred without acknowledgment. Crash windows intentionally prefer missing an alert over replaying one.

FCM callbacks perform no network calls; WorkManager runs independently of the WebView and retries failed work up to four retries, with periodic 15-minute reconciliation. Each pass has a 45-second work budget checked between operations; bounded socket/token waits can extend that budget. A pass that acknowledges pending events while history is truncated schedules a subsequent durable pass; acknowledged alerts are never replayed. If all remaining alerts are deferred, the next hint/resume/periodic pass retries without a tight loop. Android scheduling, Doze, force-stop, connectivity and FCM delivery still limit timing. This does not guarantee immediate erasure on an offline or suspended device. On notification tap the app opens; it does not put message IDs or credentials in a URL.

## Validation and remaining gates

`PushPolicyTest` covers tombstone precedence, missing-authority suppression, duplicate dismissal and retract-first ordering. `PushStoreTest` is an Android instrumentation test for encrypted storage/reload and generation rejection after logout/account replacement. It must run only in the disposable test app because it clears push state. Neither test claims real FCM delivery.

Pending until separately recorded: Kotlin/Rust compilation and tests, installed APK plugin/permission behavior, Keystore instrumentation tests, configured physical Android FCM token acquisition, background delivery/retraction and reconnect recovery. Apple requires native APNs registration/background handling, notification removal and Keychain integration on Maya; this Android bridge does not advertise Apple support. Live Firebase/APNs credentials and device delivery are not available in this implementation task.

Primary API references: [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [FCM Android setup and opt-in](https://firebase.google.com/docs/cloud-messaging/android/get-started), [FCM receive handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [WorkManager releases](https://developer.android.com/jetpack/androidx/releases/work), [Firebase Android releases](https://firebase.google.com/support/release-notes/android).
