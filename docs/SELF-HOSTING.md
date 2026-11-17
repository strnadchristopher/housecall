# Self-hosting Housecall

This recipe runs the existing server image, ClamAV and Caddy. It is source-validated; a clean-host install, certificate issuance and a two-network call have **not** been executed in this lane. The parent must build and push the versioned image before the release workflow can verify it. Nothing here changes repository or package visibility.

## Current publication boundary

The November 2026 bootstrap, storage-budget and deployment-workflow fixes are in the
publication source. Previously published `0.4.x` images predate those fixes, and the
registry package has not been qualified for unauthenticated installation. Making the
source repository public does not publish or update its container package. For the
reviewed implementation, use the root README's source-build Compose path. Treat the
prebuilt-image recipe below as a separate release gate until a fixed immutable image
has been built, exercised and made available; do not claim the old image includes the
new controls.

## Release order (parent operated)

The desktop release workflow is manual-dispatch only on Council Linux/macOS runners, with `publish=false` by default and no hosted fallback. It does not build server images. Tag pushes publish nothing. Keep the selected release tag immutable; its client package, Tauri and Cargo versions must match the tag without `v`. Every downstream checkout uses the resolved tag commit. Only an existing draft release may be reused; published releases are refused.

1. On an authorized build host with sufficient disk, use a **clean checkout of the exact release tag**, including these release scripts, and record the tag commit and build evidence. Build the repository `Dockerfile` for `linux/amd64`, set the OCI source/version/revision labels, and push **only** `ghcr.io/OWNER/REPO:VERSION` derived from the trusted repository. Do not update `latest`. For example, with parent-validated `TAG`, `REPOSITORY` and a clean current checkout:

   ```sh
   VERSION="${TAG#v}"
   REVISION=$(git rev-parse HEAD)
   PACKAGE=$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')
   docker buildx build --platform linux/amd64 --file Dockerfile \
     --label "org.opencontainers.image.source=https://github.com/$REPOSITORY" \
     --label "org.opencontainers.image.version=$VERSION" \
     --label "org.opencontainers.image.revision=$REVISION" \
     --tag "ghcr.io/$PACKAGE:$VERSION" --push .
   ```

   Record the pushed top-level digest (the index digest when Buildx emits an OCI index). Labels alone do **not** prove a reproducible build or exact-tag provenance: retain the separate clean-checkout/build/provenance evidence. This lane ran no image build.
2. Read the registry back using `scripts/verify-registry.py --repository "$REPOSITORY" --tag "$TAG" --digest "$EXPECTED_DIGEST" --revision "$REVISION"` with a parent-authorized ephemeral `GITHUB_TOKEN` environment value and its GitHub username in `GITHUB_ACTOR`. The release job uses its own read-only `GITHUB_TOKEN`; no token is written to a file or logged. The verifier fixes the registry to GHCR, compares the version tag and immutable digest, hashes manifest/config bytes, selects the Linux amd64 descriptor from an index (ignoring attestation descriptors), and checks config platform and OCI identity. It does not verify layer bytes, provenance attestations or runtime behavior. Fixture tests are source/CI checks, **not live registry proof**.
3. Pull and exercise `ghcr.io/OWNER/REPO@sha256:...` on an isolated host with synthetic configuration and data. Record the exact digest, health, scanner/upload behavior, persistence/restart checks and real two-network call evidence. Deploy the server and complete acceptance **first**. A draft desktop build alone is not acceptance. Pin `HOUSECALL_IMAGE` to the accepted digest for rollout where appropriate.
4. Only after server acceptance, manually dispatch the desktop release with the same tag, expected digest and `publish=true`. A prior dispatch with `publish=false` can prepare signed client assets and verify the full asset set while leaving the release draft. The publishing dispatch reruns verification/builds, reuses only that draft, verifies updater assets and then publishes clients as latest. The workflow does not establish server acceptance automatically; the parent owns that decision and remaining native, Apps and media gates.

Private GHCR package grants for the repository's Actions token (`packages:read`) and for each pulling account remain prerequisites. The parent's current `gh` OAuth scopes are `gist`, `read:org`, `repo`, `workflow`: they contain **no `write:packages`**, so that session cannot be assumed to push images. Parent must arrange separately authorized package-write access; this repair performs no authentication or network changes.

The existing manual [deploy workflow](../.github/workflows/deploy.yml) is a separate **source-based backup/rollback route**. It validates a release-shaped tag before checkout and archives its pinned commit for the existing deploy script; it does not deploy the verified registry digest. Preserve its backup/rollback process and validate it independently. Neither its public health check nor a registry label check substitutes for server acceptance.

## Prerequisites

Use a Linux Docker host with Docker Compose v2.24+ (inline configs), Python 3, enough memory for the scanner (up to 4 GiB plus the app), persistent disk and backups. The published image targets Linux amd64; ARM hosting is not yet validated. Obtain `compose.easy.yaml` and `scripts/init-env.py` from the same release checkout or authenticated release source. Keep that installation directory private.

The GHCR package is private. An account with package access must first authenticate using a token with `read:packages` and any organization authorization required by GitHub:

```sh
docker login ghcr.io --username YOUR_GITHUB_USERNAME
```

Enter the token at the password prompt; never put it on the command line. Do not assume making the repository public automatically makes its existing GHCR package public. The host operator must explicitly verify package access policy before removing this prerequisite.

For public hosting, create DNS A records for your domain pointing at your reachable public IPv4. Remove incorrect AAAA records. Forward TCP 80 and 443 to this host, allow outbound certificate-authority access, and forward UDP 50000 separately for calls. Caddy provisions and renews certificates automatically. A proxy/CDN in front must support the chosen certificate challenge, or leave DNS unproxied for this recipe. CGNAT may prevent direct inbound connectivity.

## Start

After authentication, DNS and firewall prerequisites, run these three commands in the installation directory, substituting your real domain and reachable IPv4:

```sh
python3 scripts/init-env.py --easy --output .env --domain chat.example.com --public-ip 203.0.113.10
docker compose --env-file .env -f compose.easy.yaml pull
docker compose --env-file .env -f compose.easy.yaml up -d
```

The initializer creates mode-0600 secrets without displaying them. Reruns leave an existing destination byte-for-byte unchanged, including after owner setup. Edit `.env` locally to change settings. `HOUSECALL_IMAGE` defaults to the versioned `:0.4.0` image, not the mutable `:latest`. Pre-release tags require setting the matching image version explicitly.

Open `https://chat.example.com`. On an unclaimed host, choose its setup path and use the setup credential from `.env` in a private local editor. Create the owner, then remove `HOUSECALL_SETUP_TOKEN` from `.env` and recreate the app with the same Compose command. Do not rerun initialization to rotate secrets. Losing `HOUSECALL_MEDIA_KEY` makes stored media unreadable. Back up that key privately alongside a consistent SQLite/data backup.

The app runs as UID/GID 10001. A restricted initializer owns the named `app-data` volume root and sets mode 0700. Scanner init assigns UID/GID 100:101 to the socket directory; ClamAV uses the same authoritative config as `infra/clamd.conf`. Its socket is shared read-only with the app. Named volumes retain messages/media, scanner signatures and Caddy certificate state across recreation. `down -v` deletes them and is not an upgrade or troubleshooting step.

## HTTPS

The checklist's HTTPS signal comes from the current request's `X-Forwarded-Proto`, set by the reverse proxy. It is not a certificate audit. The easy recipe exposes only Caddy for HTTP; do not expose the app directly or trust arbitrary forwarded headers on an exposed backend. A browser loading the real HTTPS origin without a certificate warning is the separate client-side check. A configured `HOUSECALL_PUBLIC_URL` alone is not evidence of live HTTPS.

`HOUSECALL_ORIGIN` and `HOUSECALL_PUBLIC_URL` must match the HTTPS address users open. The latter is also used for passkeys and invite links. To enable desktop origins, add `HOUSECALL_CLIENT_ORIGINS=tauri://localhost,http://tauri.localhost` to `.env`; Android passkey signing origins require the actual signed app configuration documented in `.env.example`.

## Call port

`SFU_PUBLIC_IP` is a numeric IPv4 clients can reach. `SFU_PORT` defaults to 50000. `SFU_HOST_BIND=0.0.0.0` publishes that UDP port outside the machine. Changing only the advertised address does not create router forwarding or a firewall rule. HTTPS reverse proxies and Cloudflare Tunnel do **not** carry this UDP media path. There is no TURN fallback. Restrictive networks may prevent calls.

The first-run checklist always leaves external UDP verification outstanding, even when the SFU is configured. Test with two actual clients on different networks: join the same voice channel, verify bidirectional audio/video, then reconnect. A bound socket or generic UDP port scan does not prove WebRTC works. Settings → Apps indicates integration configuration, not external connectivity.

## Storage

Media admission defaults to 20 GiB of declared reservations globally, 4 GiB per owner, 2 GiB per ordinary upload, 16 incomplete uploads per owner and 10,000 total uploads. These provisional limits are configurable through the five `HOUSECALL_MEDIA_*` budget variables in [.env.example](../.env.example); both Compose recipes forward them. Sealed DMs retain their existing per-file cap and consume the aggregate budgets. See [storage admission and retention details](SETUP.md) before raising limits. They are not tenant capacity/billing promises or physical filesystem quotas: allow headroom for chunks/metadata, SQLite, logs and backups, and validate disk monitoring. Existing over-budget data is retained for reads/deletion. No new automatic expiry removes customer uploads; define retention and reviewed manual cleanup before paid hosting.

The checklist obtains and rolls back a SQLite write lock; it does not test file uploads, free space or backup restoration. Verify an actual synthetic upload/download with scanner healthy, check free disk and inspect service health separately:

```sh
docker compose --env-file .env -f compose.easy.yaml ps
docker compose --env-file .env -f compose.easy.yaml logs --tail 80 scanner
```

Inspect logs locally and redact before sharing. Never paste `docker compose config` against real secrets; it expands environment values. To inspect only the model, use the synthetic-env checks described in the handoff.

## No public domain: Tailscale

Use an existing Tailscale tailnet with all participants enrolled and access allowed by its ACLs. On the host, obtain its numeric Tailscale IPv4 and its full MagicDNS name. Enable tailnet HTTPS certificates as required by Tailscale. Set `HOUSECALL_ORIGIN` and `HOUSECALL_PUBLIC_URL` to the host's full MagicDNS HTTPS URL, `SFU_PUBLIC_IP` to the host's Tailscale IPv4 and `SFU_HOST_BIND` to that same IPv4. Calls still use UDP 50000 over the tailnet; verify ACLs and a real call.

Use the repository's authoritative `compose.yaml` for this variant (local build required): set `HOUSECALL_PORT=4317`, initialize `.env` with `python3 scripts/init-env.py`, edit it privately, then:

```sh
docker compose up -d
tailscale serve --bg http://127.0.0.1:4317
```

Serve terminates HTTPS for the tailnet and proxies the loopback HTTP backend. Do not enable Funnel for a private tailnet recipe. A source build can require substantial disk; it was not run here. Parent must validate the installed Tailscale CLI, HTTPS setup, access policy and two-client calls.

## Cloudflare Tunnel

With an existing configured tunnel, use `compose.yaml`'s loopback `127.0.0.1:4317` HTTP backend as the ingress service. Set both public URL/origin values to the tunnel's HTTPS hostname. Keep the app bound to loopback. Configure the tunnel using Cloudflare's own authenticated setup; no tunnel token belongs in this repository. This covers web/API traffic only. Calls still require direct inbound UDP at `SFU_PUBLIC_IP:SFU_PORT`, or a mutually reachable tailnet path. A tunnel alone does not solve CGNAT for calls. Provider-specific tunnel setup has not been run in this lane.

## Apps and updates

Follow [VM](apps/VM.md), [Gimme](apps/GIMME.md), [Plex](apps/PLEX.md), [DJ](apps/DJ.md) and [GIFs](apps/GIFS.md). Keys are host-wide; only the owner configures them. Docs links in the private app currently require GitHub repository access. For optional app settings in the easy install, add the documented keys to `.env` and recreate `app` with `docker compose --env-file .env -f compose.easy.yaml up -d app`.

Before upgrades, stop writers and back up the app data plus private keys using your normal protected backup tooling; verify restoration on an isolated host. Pin `HOUSECALL_IMAGE` to the new release, pull and recreate. Do not delete volumes. Retain the prior image and pre-upgrade data backup for rollback; database migrations may require restoring that backup. VM is an explicit separate source-compose overlay, not included in the easy install.

## Optional hosted browser client

The hosted build is separate from your server's own client and the native release.
To allow it, add this exact origin to the community server environment and restart
through your normal release process:

```sh
HOUSECALL_CLIENT_ORIGINS=https://housecall.chat
```

Keep your existing server origin configuration. The hosted browser connects directly
to your HTTPS REST API, uploads, events and media; RTC connects to your configured
SFU. HouseCall's account service does not relay those requests. A trusted certificate,
reachable HTTPS address and working SFU/ICE network configuration are still required.
An IP address works only with a certificate trusted for that IP. Private addresses
work only from browsers on a network that can reach them; browser local-network
permission policies may also apply. The server's own web client remains available
for older releases or incompatible browser configurations. Never disable TLS checks.

### Optional public directory publication

Requires a separate self-host server release containing `server/src/directory.rs`;
updating the public website does not install this support on community servers.
Existing servers remain private. A server owner may enable support with:

```sh
HOUSECALL_DIRECTORY_ENABLED=yes
HOUSECALL_PUBLIC_URL=https://chat.your-domain.tld
```

Use the canonical HTTPS origin (no trailing slash, path, query, credentials or invite).
Only the owner can read or change `/api/directory`. In the home server's Server
profile, choose **List this server publicly**, copy the displayed DNS TXT record
at `_housecall-directory.<hostname>` to your DNS provider, then confirm **Publish**.
The TXT value is `housecall-directory=<sha256 of the server Ed25519 SPKI DER key>`.
The signing key stays in this server's database; protect its file and backups.
The browser receives the public fingerprint only. The server signs its own name,
origin, public description, opt-in flag and timestamp and sends that metadata to
`https://housecall.chat/api/directory/publish`, with no redirects or credentials.
The directory verifies the signature and current DNS proof. It never probes the
community over HTTP, fetches chat content, or accepts publication by a central user.

Search exposes only the name, description and HTTPS address. It grants no admission,
role or membership. Search does not contact listed communities; choosing Open starts
the browser's direct authentication/invite/access-request flow. Owners can update
or unlist using the same switch. Updates and removals require current DNS ownership.
Listings expire from search seven days after publication; use **Update listing**
to renew. There is no automatic renewal worker in this candidate. A server that is
offline can therefore remain listed for up to seven days.

For owner recovery, restore the server database/signing key and normal owner access.
If the key is lost, establish normal server ownership first, generate a new key via
Server profile, replace the DNS TXT value and republish. Current DNS control permits
key rotation. Removing a TXT record alone does not immediately unlist an existing
entry; publish an explicit unlist or wait for expiry. DNS access itself is managed
outside HouseCall. No password-reset or membership recovery is added here.

The central directory also requires the operator gate `PORTAL_DIRECTORY_OPEN=yes-reviewed`.
Keep it closed until the exact-candidate cross-origin acceptance and service/Caddy
checks described in `docs/ux/hosted-webapp-implementation.md` pass. Registration and
hosting gates remain independent. A debug server binary accepts only a loopback
`HOUSECALL_TEST_DIRECTORY_URL` for synthetic tests; release binaries always use the
fixed public directory URL. Never run the browser acceptance against a release
binary or a real community: it deliberately creates synthetic accounts and listings.
