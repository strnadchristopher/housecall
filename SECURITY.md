# Security policy

## Supported versions

Only the latest release is supported. Please update before reporting.

## Reporting a vulnerability

Report through GitHub private vulnerability reporting: open the repository's **Security** tab
and choose **Report a vulnerability**. Please do not open public issues or pull requests for
security problems.

## Known limitations

HouseCall is pre-release software. Its encryption has had no independent external audit.
The [November 2026 source review](docs/security/SECURITY-AUDIT-2026-11.md) is a bounded review,
with open findings and unrun acceptance gates, not a formal assessment or release approval.

Channels, group DMs and calls are not end-to-end encrypted. The operator can read their
messages, decrypt ordinary uploads with the server-held media key, and access call media.
One-to-one DMs and sealed attachments use client-side encryption when both people have
security keys. First contact uses trust on first use; compare safety numbers. There is no
forward secrecy. Old plaintext messages are not retroactively encrypted. A modified web
client can expose keys and content to whoever serves it. Membership, timing, sizes and
other metadata remain visible to the server. Sealed attachments cannot be malware-scanned
by the server, and view-once delivery cannot prevent a recipient from making copies.

The optional public portal account stores an encrypted server-address list, separate from
community logins. It has no password reset or recovery. A compromised portal publisher or
browser can read an unlocked list; root access and backups also matter. Deleting an account
does not guarantee physical erasure from storage or backups.
