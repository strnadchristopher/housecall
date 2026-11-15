# Gimme

Gimme requests are host-wide and submitted from eligible channel activity, not encrypted DMs. The default worker and `compose.yaml` use test mode: operations can be recorded in chat without contacting Gimme. This is not proof of a completed provider download.

For real forwarding, provision a Gimme agent API key locally and set:

```dotenv
GIMME_BASE_URL=https://gimme.example.com
GIMME_AGENT_API_KEY=
GIMME_DRY_RUN=false
```

Use an HTTPS origin with no path, credentials, query or fragment. HTTP is accepted only for loopback fixtures; container loopback refers to the app container, not another service. Both URL and key are required for a real worker; an empty URL keeps test mode. Never paste the key into chat.

`compose.easy.yaml` honors `GIMME_DRY_RUN` from `.env`. The authoritative `compose.yaml` deliberately hardcodes `GIMME_DRY_RUN: "true"`: changing `.env` alone cannot turn on forwarding there. For that source recipe create a local override (keep it out of version control if it contains secrets):

```yaml
services:
  app:
    environment:
      GIMME_DRY_RUN: "${GIMME_DRY_RUN:-true}"
```

Save as `compose.gimme.yaml`, then run `docker compose -f compose.yaml -f compose.gimme.yaml up -d app`. For easy hosting, run `docker compose --env-file .env -f compose.easy.yaml up -d app`. Check Settings → Apps, submit a synthetic request, confirm it exists at the actual provider, and verify completion or a visible failure. Do not resubmit an outcome-unknown request blindly; inspect its recorded operation first. No real provider request was executed in this W6 pass.

See [hosting](../SELF-HOSTING.md) for prerequisites and persistence.
