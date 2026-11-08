# Independent auth, VM input, data and voice source review

Reviewer `/root/native_review`, Astra/high, read-only. Native auth/deep-link exact Android certificate origin allowlisting and structured data received no confirmed material findings. VM post-handshake voice revocation and total QMP deadline findings were repaired and independently reread. Scanner WNOWAIT process-group fix also reread. No Rust/Kotlin/device/engine execution by reviewer.

At the stable voice candidate, independent commands from `client`:

- `npm test -- --maxWorkers=1`:33/33 tests across3files passed. Copied receipt `evidence/recovery-independent-voice-unit.log`.
- `./node_modules/.bin/tsc --noEmit`:exit0. Copied receipt `evidence/recovery-independent-voice-types.log`.
- `git diff --check`:passed.

Reviewed voice SHA256 (this snapshot predates subsequent VM media bindings):

```
fd5f075943f582fa5d44a21f0dc8699045e09fb95c4dd7f50da18639a5920b4b client/src/transport/voice.ts
e1e3b586016d1edadeaf2ec1becc723efda708b50f811cb92519ef380f378275 client/tests/voice-lifecycle.test.ts
9160f68b82d17d8baee954431895792a906186efb6dcff24729443a4578f1b9d client/src/App.tsx
bfe94e66bf9bf1276ea971b862e9e2ddc1956f37f5e803d663d3b8c23ef57d9c client/src/contracts/ui.ts
20d423e3a2b30c929846eecf6d8f30080803a4835d8eff5d17fe95e60a498409 client/src/hooks/useChriscord.ts
```

Voice tests use fake MediaStream/RTCPeerConnection boundaries. They exercise delayed permission/join/display/stats teardown, audio-only constraints/device selection, and permission-free enumeration; they do not establish real browser, native device, SFU capacity or visible UI adoption. No remaining confirmed material voice source finding was reported in that bounded slice.
