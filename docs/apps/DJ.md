# DJ

DJ requires the SFU, encrypted uploads, scanner/transcoder dependencies and a reachable chat-completions endpoint. The existing Dockerfile includes `espeak-ng`, ffmpeg, Node and checksum-pinned yt-dlp. The default voice uses local espeak; a hosted voice-clone dependency is not required.

```dotenv
DJ_ENABLED=true
SWITCHBOARD_URL=https://switchboard.example.com/v1/chat/completions
SWITCHBOARD_API_KEY=
```

Use your actual endpoint URL and private key if it requires one. Both Compose recipes set `DJ_TMPFS_DIR=/tmp/housecall-dj` on the app's tmpfs. Plaintext staging must stay on tmpfs; the server rejects a disk-backed scratch directory. The default 128 MiB app tmpfs can limit song preparation; verify intended tracks before changing resource limits.

Recreate the app with the chosen [hosting command](../SELF-HOSTING.md#apps-and-updates). In a voice channel start DJ, request a safe test track, verify introduction/audio for two listeners, votes, skipping and cleanup on stop. Readiness is configuration only. External provider/download access, quotas and availability need separate verification; this pass made no billed API calls.

Leave `DJ_TTS_COMMAND` unset for the bundled default. A custom executable additionally requires the server's `DJ_REFERENCE_WAV` and `DJ_TTS_MODEL_DIR` and appropriate private mounts/environment via an explicit override. `.env.example` currently names `DJ_REFERENCE_AUDIO`, which the server does not consume; neither stock Compose recipe forwards custom TTS keys. Do not treat that example key as a working custom-voice recipe. No custom TTS integration is claimed here.
