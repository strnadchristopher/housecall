# Plex

Set both `PLEX_URL` and `PLEX_TOKEN`, or leave both empty. Use the Plex server's reachable origin (for example `http://plex:32400` on an explicitly shared Docker network), not a Plex web UI path. A hostname from another Docker network is not automatically reachable from Housecall. Store the server token only in the host's private `.env`.

```dotenv
PLEX_URL=http://plex:32400
PLEX_TOKEN=
```

Recreate the app using your chosen [hosting Compose command](../SELF-HOSTING.md#apps-and-updates), then check Settings → Apps. Calls must be configured too. Start a Plex watch activity in a voice channel, browse a known library, select a synthetic/test title and verify playback plus late-joining synchronization on two clients. Configuration readiness does not verify library access, transcoding or playback. Do not expose Plex's token to browsers or put it in a shareable URL.

The existing server proxies Plex requests/media; library permissions and playable formats still depend on your Plex server. No live Plex token, library or playback was accessed during this lane. Runtime acceptance remains with the parent.
