# Native push source review checkpoint

Reviewer: independent `/root/native_review`, requested gpt-6-astra/high; read-only review of integrated HEAD `aecee37e93a4532c6bbe465ee5b8e2ab7fd9d5d6` plus retained dirty native source. No build, unit test, emulator or live provider execution by reviewer.

Confirmed findings repaired and reread:

1. Firebase token or backend registration failure skipped authenticated deletion/session cleanup. Tombstones and authoritative OS inventory now reconcile before registration.
2. An acknowledgment failure on the first tombstone skipped later local removals. All fetched local removals now finish before acknowledgment I/O.
3. Tauri Rust errors serialize as strings; frontend discarded their actionable text. Adapter converts strings to Error and browser fixture now uses actual string-rejection shape.
4. Token acquisition could wait20s after the first authority snapshot. Fresh authenticated notification authority and inventory reconciliation now follow registration before any new alert.

Regression source: `client/src-tauri/gen/android/app/src/androidTest/java/com/littleobelisk/chriscord/PushReconcileTest.kt`, `client/tests/state.test.ts`, and `client/tests/e2e/native-push.spec.ts`. Android tests exercise real encrypted ledger mutations with injected network/token boundaries; they are not live FCM or actual notification-delivery proof. The authority regression requires two reads, preventing a vacuous pass solely from missing notification permission.

Reviewed SHA256:

```
d18b5c3133be6de44b9de86a6f22f4af0f16259c8cba5e5c758b02782d73b6f2 PushRuntime.kt
f993b7f6a8f9bc7b914934dfbb219027049c981185e0de8eb428f2ad2f42ab41 PushReconcileTest.kt
dc9b0dbe258c7e2a896b1a86ab2a4c5b1eff768817d48c0095e4521d3dc9ae6f nativePush.ts
```

Reviewer and implementer `git diff --check` passed. Compile/tests and physical native delivery/retraction remain pending separately.
