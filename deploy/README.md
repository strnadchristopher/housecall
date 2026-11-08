# Shiva deployment handoff

This package builds from the repository root with `docker build -t chriscord:local .`. Compose runs the app and its ClamAV scanner. The `vm` profile is optional and is not part of the friend-group deployment.

## Prepare

1. Ensure the Caddy container is attached to the existing Docker network `lo-proxy`.
2. Copy `deploy/.env.example` to `.env`, set `CHRISCORD_SETUP_TOKEN` and `CHRISCORD_MEDIA_KEY` to independent random 32-byte hex values, and set `SFU_PUBLIC_IP` to Shiva's numeric public IPv4 address. For example, generate each secret with `openssl rand -hex 32`.
3. Set `RESEND_API_KEY` and `CHRISCORD_MAIL_FROM` to the verified Resend sender when email invitations are ready. If the API key is empty, the server logs each invitation link for development; it does not send email.
4. Create the bind-mounted data directory and make it writable by the container's UID 10001:

   ```sh
   install -d -o 10001 -g 10001 -m 0700 ./data
   chmod 600 .env
   ```

`CHRISCORD_ORIGIN` and `CHRISCORD_PUBLIC_URL` must match `https://chriscord.littleobelisk.com`. The setup token initializes the first owner once through `/api/setup`; later requests are rejected after the first account exists. Keep it private and remove it from `.env` after setup.

## Start and proxy

From the repository root, build and start the app and scanner:

```sh
docker compose up -d --build app scanner
```

The app joins `lo-proxy` with the stable alias `chriscord`; Noah can point Caddy at **`http://chriscord:3000`**. Caddy's normal `reverse_proxy` handler supports WebSocket upgrades. Chriscord currently uses authenticated HTTP requests and polling for events; voice signaling also uses HTTP. The actual WebRTC media does not pass through Caddy.

Compose publishes the SFU's configured UDP port on `SFU_HOST_BIND`. For Shiva, use `SFU_HOST_BIND=0.0.0.0`, `SFU_PORT=50000`, and `SFU_PUBLIC_IP=<Shiva public IPv4>`; permit and router-forward **UDP 50000** to Shiva. Keep TCP application traffic on the `lo-proxy` network. There is no TURN service or TURN client configuration in this release, so networks that block direct UDP may not connect voice/video.

The SQLite database and encrypted media use the `CHRISCORD_DATA_DIR` bind mount. ClamAV's signature database remains in a named Compose volume. The app's optional host port is loopback-only for local diagnostics; Caddy should use the Docker network alias above.

## Environment and ports

| Variable | Purpose |
| --- | --- |
| `CHRISCORD_SETUP_TOKEN` | One-time first-owner bootstrap token; remove after setup |
| `CHRISCORD_MEDIA_KEY` | 32-byte hex key for encrypted uploads; back it up securely |
| `CHRISCORD_DATA_DIR` | Host bind mount for SQLite and encrypted media |
| `CHRISCORD_ORIGIN` | Canonical HTTPS origin used by passkeys |
| `CHRISCORD_PUBLIC_URL` | Origin used to construct invitation links |
| `RESEND_API_KEY` | Resend HTTP API key; empty means development link logging |
| `CHRISCORD_MAIL_FROM` | Verified sender address/name used by Resend |
| `SFU_PUBLIC_IP` | Numeric public address advertised for WebRTC |
| `SFU_HOST_BIND`, `SFU_PORT` | Host UDP bind and matching SFU UDP port; default port 50000 |
| `LO_PROXY_NETWORK` | Existing Caddy Docker network; defaults to `lo-proxy` |

Only Caddy's existing HTTPS listener and the SFU UDP port need to be reachable by friends. The optional host-side HTTP mapping remains bound to loopback. No Caddy, DNS, firewall, router, or deployment changes are made by this repository handoff.
