# Final check: status of the [SPEC] findings

Source: `docs/review/final-check.md` in the `hc-ui` worktree, findings 9 to 15. Only the documents under `docs/security/` were changed. Nothing has been built or tested; these are edits to a design.

| # | Finding | Status | What changed |
|---|---|---|---|
| 9 | Host can attack members' passwords offline; summary calls it a "breach" problem | **Fixed in the text; scope of the default is open (D1)** | `SUMMARY.md`: removed the "cannot test guesses" claim, moved the attack to "What is not protected" as a hostile-host attack with the 115 GPU-day figure. `SECURITY-LEVELS.md` 6: level-4 sheet now says it. `THREAT-MODEL.md`: P4 and L2 reworded. `PROTOCOL.md` 2.3, 7.3, 3.3: new **sealed accounts** (device-signed `POST /v2/blob/seal`, no password-only blob; new devices get `RS` sealed by an approving device; unseal route). Owner and admins sealed by default. |
| 10 | Owner key has no compromise story | **(a) and (b) fixed; (c) open (D3)** | (a) `PROTOCOL.md` 3.3: the web client must not load owner or admin accounts; native clients warn (`privileged_web`, SECURITY-LEVELS 2, 3, 4, 6, fixtures). (b) new `PROTOCOL.md` 15.9 (prevention, detection, procedure: "create a new server" if the key was already used; `key_replace` on owner or admin always shows a notice naming the signing device); new limit L24; A9 and A11 updated. (c) second signature: see D3. |
| 11 | Web factors ranked above files and messages | **Fixed** | Both web factors are level 1 in `SECURITY-LEVELS.md` (table, rationale, pseudocode, notes, server level, fixtures including a DM with a web participant). `DECISIONS.md` E.4, E.7, item 19, `SUMMARY.md`, `THREAT-MODEL.md` A11, `PROTOCOL.md` 20.3 follow. `REVIEW.md` resolution 11 is left as the historical record; this file supersedes its level-3 ranking. |
| 12 | Compromise procedure thin and contradictory | **Fixed** | `PROTOCOL.md` 15.6: wraps to the old `key_id` are deleted on rotation and on any disable or class reduction; compromise is now disable entry, forced `channel_rekey` in every public channel, deletion of wraps and artifacts, a member notice with the exposed date range (from a `compromise:` reason), optional re-enable with a new key. States what it cannot undo and that how the owner learns is out of protocol. |
| 13 | "Bot: not the host" is wrong when the runner is on the server | **Fixed** | `SUMMARY.md` table, `SECURITY-LEVELS.md` (table, sheet string names the operator), `PROTOCOL.md` 16.1, 16.2, 16.3, `THREAT-MODEL.md` L13 and A8. |
| 14 | `push_text` wraps T to the host for no purpose | **Fixed** | `PROTOCOL.md`: `push_text` removed from the feature list in `features_set`, 15.1 to 15.5 and 17.3 (now "sealed push text", a server setting, no key class, no wrap, level unchanged). Four host features remain. `SECURITY-LEVELS.md`, `THREAT-MODEL.md`, `DECISIONS.md`, `SUMMARY.md` and `CRACK-PLAN.md` updated; fixtures now use `search` for the text class and add one for sealed push text. |
| 15 | 24-hour fresh-head rule pauses sending on a household server | **Open (D4)** | Spec text unchanged, because the owner must decide. Recommendation recorded in `DECISIONS.md` E.10. |

Things I could not do or did not check:

- No cross-document consistency tool exists; I searched for `push_text`, "capped", "level 3" and the web labels by hand. Test vector TV-17 is described in `SECURITY-LEVELS.md` 11 only; no vector file exists in this tree, so none was updated.
- `PROTOCOL.md` 21 (API summary) and 22 (test vectors) were not updated for the new routes `POST /v2/blob/seal` and `/unseal`, or for the `compromise:` reason code. **Add them before the spec is frozen.** Section 23 (negative tests) has no tests yet for: web client refusing an owner or admin account; sealed account refusing password-only release; wraps deleted on rotation.
- `REVIEW.md` still describes `push_text` and level-3 web as the review's resolutions; I left it as history.

## Open decisions

D1, D2 and D3 are `DECISIONS.md` E.13, E.14 and E.15; D4 is E.10; D5 is the end of E.9.

### D1. Seal ordinary members' accounts by default?

The mechanism is specified (`PROTOCOL.md` 2.3) and is already the default for owner and admins, as the finding asks.

- **A. Seal every account as soon as it has a registered device, opt-out allowed.** Removes the hostile-host password attack for everyone. Cost: a member who loses all devices and has no recovery phrase cannot sign in with a password alone any more; the seven-day waiting-period path (7.3 step 6) disappears for them.
- **B. Seal only owner and admins; members can opt in.** Keeps the password-only recovery route that casual users rely on. Cost: the hostile-host attack stays open for most members, and the summary has to keep saying so.
- **C. Seal everyone with no opt-out.** Strongest and simplest; harshest on users who lose phones.

Recommendation: **A**, with the sealing prompt explaining that the recovery phrase is then the way back in.

### D2. Ownership transfer or owner removal (finding 10 (b))

v1 answer is "create a new server" if the owner key was stolen and used.

- **A. Leave as is for v1, state it (done).** Cost: every member must move.
- **B. Add a `owner_transfer` entry signed by the owner, valid only to an active admin.** Does not help once the thief holds the key.
- **C. Add a recovery quorum: a majority of admins can sign an `owner_replace` after a delay (for example 7 days) that the current owner key cannot veto except by `key_replace` with `old_proof` from the original device.** Real recovery, but a new attack surface (colluding admins) and a new entry kind to specify and attack.

Recommendation: **A** for v1; design **C** before any server holds data that members cannot afford to move.

### D3. Second admin signature on `features_set` (finding 10 (c))

- **A. Not required (current text).** One stolen owner key turns on host reading of new public-channel epochs; members see the notice and the level drop.
- **B. Require one active admin's co-signature.** A lone stolen owner key then cannot enable host access. Cost: a server needs two admins to use any host feature, and the entry format and verification rules grow (`features_set` carries a second signature and its signer).
- **C. Require it only when turning a feature on, not off.** Same protection, no friction for the compromise procedure in 15.6, which must be usable by the owner alone.

Recommendation: **C**. If the owner decides against it, 15.9 already says so.

### D4. The 24-hour fresh-head rule (finding 15)

- **A. Keep as written:** "Not verified" and sending paused after 24 hours without another member's entry. Stops a server acting alone, not a colluding listed member; will trigger on quiet household servers.
- **B. Keep the warning, do not pause sending, window 7 days.** Detection stays; no lockout on a quiet weekend. A hostile host acting alone can freeze a view for up to 7 days before a warning appears.
- **C. Keep 24 hours and the pause, but only for channels where a removal happened since the client's last fresh head.** Targets the attack the rule was added for. More state to specify and test.

Recommendation: **B**, as the finding says. C is the better engineering answer if the owner wants the pause to mean something.

### D5. Sealed push text beyond public channels

Now that the host gets no key for it, sealed push text could cover private channels and DMs. Recommendation: not in v1 (lock-screen exposure is a client-side matter the owner has not decided), so the spec keeps those content-free.
