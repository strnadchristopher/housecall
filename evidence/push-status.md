# Push backend fixture acceptance

- Nine focused tests passed, 1.15 seconds (`push-focused-tests.log`).
- Strict server all-target clippy passed (`push-clippy.log`); owned Rust source formatting check passed.
- Actual loopback HTTP APNs/FCM/OAuth fixture requests, synthetic device tokens and ephemeral signing keys only. No host provider credentials read and no Apple/Google requests made.
- Proven: current-session registration/status/ack authorization; canonical APNs token uniqueness; encrypted token integrity; ES256/RS256 signatures; transactional alert rollback and unsend retractions; in-flight HTTP/unsend race; FCM retry after 503 with Retry-After and SQLite reopen; revocation/membership/provider invalidation; bounded history/tombstone precedence; disabled/configuration rejection.
- Not proven: native token acquisition, physical mobile delivery/background processing/OS removal, live provider compatibility, production APNs HTTP/2. Provider acceptance is distinct from device acknowledgment, and offline immediate erasure cannot be guaranteed.
- Parent owns AppState, transactional hook, environment/Compose and client/native integration wiring. The server tests exercise the parent's current integrated hooks.
