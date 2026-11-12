# Native authentication and invitation handoff

> Update on `hc-ui`: the new interface signs in with a password only. The client-side passkey flows (`registerPasskey`, `authenticatePasskey`), their unit tests and the `@simplewebauthn/browser` dependency were removed; `transport/passkeys.ts` keeps only `cancelNativePasskey` for the Android bridge. The description below is of the earlier client and the Android bridge.

Android now has a Credential Manager bridge for passkey enrollment and sign-in. The browser continues using `@simplewebauthn/browser`; Android sends the server's public-key options to the platform provider and returns its credential JSON to the existing finish endpoint. Native iOS and desktop passkey adapters are unavailable and explicitly return an unsupported result instead of attempting WebAuthn from a custom WebView origin. Password fallback remains available.

This is source implementation, not an Android device acceptance receipt. Credential Manager dependencies, Kotlin compilation, app association and actual provider registration/assertion need the checks below. No signing credential, provider account, asset-links publication or device provisioning was performed for this change.

## Android configuration and trust

Set the public build setting `HOUSECALL_AUTH_ORIGIN=https://chat.example.test` to the intended self-hosted server. It must be the exact lowercase HTTPS origin, without a port, path or trailing slash. An unset value leaves native passkeys and native invitation links unconfigured. This one-server pin applies to the native bridge; password sign-in retains the existing server selection behavior.

The build generates `BuildConfig.AUTH_ORIGIN`, the HTTPS App Link host and the app's Digital Asset Links include statement. The bridge derives `android:apk-key-hash:<base64url SHA-256 certificate digest>` from the installed APK's signing certificate. It requires Android 9/API 28 or newer and one current APK signing certificate. Provider availability is checked by the OS operation; `nativePasskeyStatus()` does not claim a provider or domain association has been verified. The two pinned AndroidX Credential Manager artifacts are version 1.5.0; the Play Services integration enables supported providers on older Android versions.

Configure server `HOUSECALL_ORIGIN` to the same HTTPS origin and `HOUSECALL_ANDROID_PASSKEY_ORIGINS` to the explicit comma-separated approved APK certificate origins. The server returns its approved Android origins in `android_origins` on both start responses. The TypeScript and Kotlin adapters require that list to include the installed app, and require the returned RP ID to equal the pinned hostname. The server still verifies the cryptographic response, exact origin, challenge lifetime, single use, and registration account/session binding. No client-supplied origin grants server trust.

Credential Manager receives no `origin` or `clientDataHash` override. An ordinary app must not impersonate an HTTPS browser origin; Android responses use the certificate origin. [Android origin verification](https://developer.android.com/identity/passkeys/create-passkeys), [privileged origin overrides](https://developer.android.com/identity/sign-in/privileged-apps).

Provision `https://<RP host>/.well-known/assetlinks.json` with the following public association data, using the installed APK's actual SHA-256 certificate fingerprint in colon-separated hex:

```json
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "com.mapleavenuelabs.housecall",
      "sha256_cert_fingerprints": ["REPLACE_WITH_APPROVED_CERTIFICATE_SHA256"]
    }
  }
]
```

The response must be HTTP 200 with JSON content type and no redirects. Credential providers must be able to retrieve it; a Tailscale-only hostname without an accessible association file does not establish working Google Password Manager passkeys. This public metadata contains no invite/session credentials and does not make registration public. Keep debug certificates restricted to the isolated test RP. Certificate rotation and release signing require deliberate updates to both this association and the server allowlist. [Android Digital Asset Links prerequisites](https://developer.android.com/identity/credential-manager/prerequisites), [documented private-network verification constraint](https://developer.android.com/blog/posts/zoho-achieves-6x-faster-logins-with-passkey-and-credential-manager-integration).

## Runtime behavior

`client/src/transport/passkeys.ts` exports `nativePasskeyStatus()` and `cancelNativePasskey()` as well as the existing enrollment/login functions. A single Android provider request may be active. It expires after 100 seconds, cancels on Activity destruction, and ignores late callbacks. Provider errors are reduced to fixed messages, never raw provider diagnostics. The app does not store challenge/credential payloads or log them. The same `Api` transport sends finish requests with its existing bearer/device headers; it refuses to submit if the API origin changed during the prompt. Server verification remains authoritative.

`client/src/transport/deepLinks.ts` exports:

```ts
interface InviteLink { token: string; server_origin: string }
subscribeInviteLinks(onInvite: (invite: InviteLink) => void,
                    onError?: (error: Error) => void): () => void
```

Invitations use only `https://<configured host>/#invite=<64 lowercase hex characters>`. Android's manifest handles the exact root path. Native code independently rejects other schemes/hosts/paths, credentials, ports, query tokens, URL normalization tricks and extra fragment fields. The fragment is intentionally absent from HTTP request targets. No custom-scheme invitation fallback is registered.

Cold-start and warm Activity intents feed one in-memory invitation slot with a two-minute lifetime. The raw URI is cleared from the Activity intent before Tauri/plugin dispatch. The frontend acknowledges its opaque receipt ID only after a live callback receives the invitation; teardown during IPC does not discard it. Browser delivery strips the fragment before callback. The callback prefills the existing invitation flow only; it must never redeem automatically or replace a signed-in account. The native inbox is not persisted across process death. The app adds no invitation logging or external URL forwarding; shared invitation links themselves are bearer secrets and should not be placed in diagnostics.

## Verification after the shared build lane is free

From the repository root:

```sh
cd client
./node_modules/.bin/vitest run tests/native-auth.test.ts --maxWorkers=1
./node_modules/.bin/tsc --noEmit
```

From `client/src-tauri/gen/android`, run the unit-test task matching the generated architecture flavor (currently `arm64`), after supplying `HOUSECALL_AUTH_ORIGIN` for the isolated test RP:

```sh
./gradlew :app:testArm64DebugUnitTest --tests com.mapleavenuelabs.housecall.NativeAuthPolicyTest --no-daemon --max-workers=1
```

Rebuild through the existing Tauri Android path, rather than assuming a Kotlin-only build refreshes the Rust command handler:

```sh
cd client
HOUSECALL_AUTH_ORIGIN=https://chat.example.test ./node_modules/.bin/tauri android build --debug --target aarch64
```

On an authorized test device with a configured credential provider, screen lock and correctly associated isolated RP, install the resulting APK. These commands inspect/refresh App Links; they do not force-approve a failed association:

```sh
adb shell pm verify-app-links --re-verify com.mapleavenuelabs.housecall
adb shell pm get-app-links com.mapleavenuelabs.housecall
```

After asynchronous verification, require `verified` for the actual RP host. To test link routing without exposing a live invite in shell history, use this deliberately invalid fixture token against the configured test host:

```sh
adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'https://chat.example.test/#invite=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
```

Repeat with the app closed and already running; verify correct origin/token prefill, no automatic account switch, and no unexpected browser navigation. For acceptance, open a real expiring test invite privately, redeem once, enroll a passkey, sign out, sign in with the OS picker, and reject replay/expired challenges. Check user cancellation, timeout, Activity destruction, wrong certificate, wrong RP, missing association, unavailable provider and Android below API 28. Confirm browser virtual-authenticator regressions remain green and password fallback works. Do not collect token-bearing network traces/screenshots/logcat. [App Link verification procedure](https://developer.android.com/training/app-links/verify-applinks).

`tests/native-auth.test.ts` covers browser preservation, native JSON/challenge transport, bearer/device headers, certificate/RP refusal, unsupported native platforms, cancellation/server changes, strict invitation parsing, browser fragment removal and acknowledgment after delivery. `NativeAuthPolicyTest.kt` checks canonical HTTPS/RP/certificate policy and malicious link forms without invoking a credential provider. Neither suite proves a real Android passkey ceremony or iOS support.

## Custom scheme: `housecall://invite?code=…` (iOS and Android)

Universal Links would need an Apple association file on every self-hosted domain, so invites also open the app
through a custom scheme. The only accepted shape is `housecall://invite?code=<hc1 invite code>`: no other host,
path, parameter or fragment. The code carries the server origin (`hc1.<base64url(origin)>.<64 hex token>`, https or
loopback http only), so one scheme works for every server. The web join page shows "Open in the Housecall app" on
phones, linking to the same invite in this form.

- **iOS:** `Info.ios.plist` registers the scheme (`CFBundleURLTypes`). The OS hands the URL to the running app as
  Tauri `RunEvent::Opened` (cold or warm); `src-tauri/src/scheme_invite.rs` checks the shape and keeps the newest URL
  for 120 s in memory. The web layer polls `scheme_invite_take` (one-shot) and parses it with `parseSchemeInvite`.
- **Android:** an `<intent-filter>` for `housecall://invite` on `MainActivity`. `InviteLinkInbox` captures it the same
  way as the https link (removed from the intent before Tauri sees it, 120 s, no persistence) after
  `NativeAuthPolicy.schemeInvite` checks the shape; `native_auth takeInvite` returns it as `{id, url}` and the web
  layer acknowledges it.
- **Both:** the URL goes into the same `onInvite` path as https links: signed out it prefills Join; signed in it
  asks first ("Join a server on …?") and never joins silently.
- **Why not `@tauri-apps/plugin-deep-link`:** it is not a dependency, and nothing here needs it. iOS already gets
  `RunEvent::Opened` from Tauri core once the scheme is registered, and Android already has a reviewed intent inbox
  for invite links. Adding the plugin would duplicate both paths and add a capability surface.
- **Risk:** any app can register `housecall://`. The payload is only an invite (a bearer secret the sender chose to
  share); it never redeems without a person confirming, and only prefills a form when signed out.
- **Unverified on device** (needs Maya / the Android emulator): cold and warm opens on iOS, the Android intent filter,
  and the Kotlin changes (not compiled in this lane).
