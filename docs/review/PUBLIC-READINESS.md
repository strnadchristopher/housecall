# Public-readiness review — W6

Status: **not cleared for public release**. This pass changed source/docs only. Repository and package visibility were not changed, and no registry publish, production credential read or deployment occurred.

## History scan

2026-11-14: `command -v gitleaks`, `command -v trufflehog` and `command -v detect-secrets` found no executable on PATH. No tool was installed. `python3 scripts/scan-selfhost-history.py` returned exit 2: scanner unavailable, no history scan performed. There is no clean-history result and no regex substitute is represented as a comprehensive scan.

Parent prerequisite: provide an approved installed Gitleaks release supporting `gitleaks git`, record its version and rule/config scope, then run from the lane root:

```sh
gitleaks version
python3 scripts/scan-selfhost-history.py
```

The wrapper invokes `gitleaks git --redact=100 --log-opts='--all --full-history' --report-format=json --report-path <private-temporary-report> <lane-root>`. It suppresses all scanner diagnostics and emits only JSON `path` and `rule_id` pairs. Temporary scanner reports stay in a mode-0700 task directory and are removed on exit. Exit 0 means no findings reported, 1 means findings, 2 means unavailable/incomplete. A synthetic scanner fixture verifies all-ref/redaction arguments and that extra report fields/diagnostics cannot reach output. A real installed-scanner invocation remains unexecuted; confirm its version/flag compatibility before relying on the result. Do not post full scanner reports, matching lines, secrets, hashes or snippets to review channels.

Intended scope is history reachable from **all locally available refs**, including historical deleted files. No fetch was repeated. It does not cover remote-only refs, dangling/unreachable objects, release assets, GitHub secrets, external stores, production `.env`, or this lane's dirty/untracked files. A separate candidate-tree scan and manual review are also required before any public flip. Do not read production credentials for that work. Scanner exclusions, custom rules and false positives must be reviewed by the parent. Confirmed exposed credentials require owner-managed revocation; deleting history alone cannot retract a credential.

## Other release gates

The server-image workflow has job-scoped `packages: write`, builds the selected tag's existing Dockerfile, and supplies version/latest tags plus OCI source/version/revision labels. It contains no visibility mutation. GitHub's initial package visibility and existing-package access must still be confirmed by the host operator. Existing desktop signing/publication jobs are preserved.

Runtime hosting acceptance remains open: private GHCR login/pull on a clean host, scanner healthy/socket access, app volume ownership, Caddy certificate issuance/renewal, owner claim, upload round trip, persistent data/restore, external UDP two-client call, and the documented Tailscale/tunnel variants. Integration provider and VM gates are listed in [self-hosting](../SELF-HOSTING.md) and [VM](../apps/VM.md). Static Compose resolution is not runtime certification.

Fable's existing layout is retained. The design's call-port Ready/Fail copy assumed an external probe that does not exist. This pass truthfully leaves UDP externally unverified using the existing attention row; Fable should approve a distinct unverified presentation if desired. Desktop/phone real-app screenshots and adversarial UX remain mandatory before release. The existing Create Server behavior/test is retained; no new flow was designed.
