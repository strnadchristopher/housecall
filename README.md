# Housecall

Housecall is a self-hosted, invite-only chat server with a web and desktop client. You run it
for a small group of people you know. It is written in Rust (server, SQLite storage) and
TypeScript (client).

## Status

**Pre-release.** Expect rough edges, breaking changes and missing polish.

- Messages are **not** end-to-end encrypted today. The server owner can read them; uploaded
  files are encrypted at rest on the server. An end-to-end encryption protocol is under
  development and has had no independent security audit. See [SECURITY.md](SECURITY.md) and
  [docs/DECISIONS.md](docs/DECISIONS.md).
- Only run it for people who trust the person hosting it.

## Quick start (Docker Compose)

Requirements: Docker with the Compose plugin and Python 3.

```sh
python3 scripts/init-env.py        # creates .env with random secrets
```

Edit `.env` and set `HOUSECALL_ORIGIN` and `HOUSECALL_PUBLIC_URL` to the address people will
use, for example `https://chat.example.com`. Then:

```sh
docker compose up -d --build
```

The app listens on `127.0.0.1:4317`; put a reverse proxy with HTTPS in front of it. If your
proxy runs in Docker, see `compose.proxy.yaml`. Open the site, use the setup token from `.env`
to create the owner account, then remove the token from `.env`.

Invitations work without email: the owner creates one and shares the returned link. Mail is
sent only if you configure `RESEND_API_KEY` and `HOUSECALL_MAIL_FROM`.

Voice and video media uses UDP on `SFU_PORT` and does not go through the reverse proxy; see
the comments in `.env.example`. Integrations (Plex, Gimme, Switchboard, Giphy, push) are off
until you configure them.

More: [setup](docs/SETUP.md), [API](docs/API.md), [threat model](docs/THREAT-MODEL.md),
[contributing](CONTRIBUTING.md).

## License

[GNU AGPL-3.0](LICENSE).
