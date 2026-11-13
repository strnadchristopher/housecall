# Security levels: the rule

## What 0.4.0 actually builds

0.4.0 does not build the four-segment bar described in sections 1 to 12. Those sections belong to the future design in `PROTOCOL.md`, which has no signed log, no epochs, no host features and no bots. 0.4.0 shows one label per conversation, defined in `DM-V1.md` section 14.1:

| Condition | Label |
|---|---|
| One-to-one DM, native app, both people have keys, the other person's key is pinned | **End-to-end encrypted** (plus "Verified" once safety numbers were compared) |
| Same, in the web client with keys in memory | **Encrypted in browser** |
| The other person has no keys yet | **Not encrypted yet** |
| You have no keys on this server | **Not encrypted** |
| The other person's key changed and you have not accepted it | **Key changed** (sending paused) |
| Group DM, channel, voice channel | **Not end-to-end encrypted** |
| Any call, including DM calls | **Relayed by the host** |

The rule from this document that 0.4.0 keeps: "End-to-end encrypted" appears in no other state, is never abbreviated, and no other state uses its lock icon or colour. The detail sheet sentences are in `DM-V1.md` section 14.1. Activity chips (section 9 below, "Served by the host") still apply to Plex, the Shared Browser and Gimme.

Everything below this line is the future design, kept for a later release.

---

This document fixes how a client turns the verified state of a server and a channel into the level and label members see. It is a pure function of data the client has verified itself. Nothing in it comes from a server's say-so. The labels are chosen so they never claim more than the cryptography gives (`PROTOCOL.md`, `THREAT-MODEL.md`).

## 1. Levels and labels

The bar has four segments. A level is the number of filled segments, 0 to 4.

| Level | Label (at most four words) | Means |
|---|---|---|
| 4 | **End-to-end encrypted** | Only the people in this conversation hold the keys, and nobody in it uses the web version. No host feature and no bot can read it. The signed member list and key history checked out. |
| 3 | **Server sees links** | The server can read the web addresses members send, so it can make link previews. Everything else is end-to-end encrypted. |
| 2 | **Server sees files** | The server can read file contents, names and sizes (virus scanning, thumbnails, conversion). Message text is end-to-end encrypted. |
| 2 | **Server sees files, links** | Both of the above. |
| 1 | **Server reads messages** | The server can read message text (search). Files are covered too if the file features are also on. |
| 1 | **Bot can read** | A bot member can read everything in this channel, and may pass it to the services it is set up to use. Whoever runs the bot reads it too, which is often the host. |
| 1 | **Host serves this app** | (Viewer on the web client.) The page that does the encrypting came from the server's host, who could change it and read everything you can read here, text and files, in private channels and DMs too. |
| 1 | **Member on web app** | Someone else in this conversation uses the web version. Their page came from the server's host, who could change it and read what that person reads, which is everything they can see here, text and files. |
| 1 (server view only) | **Admin key on web** | The server's owner or an admin has used the web version. Their page came from the host, who could have taken their key and so could change who is in the server. |
| 1 (server view only) | **Bots in some channels** | The server itself is not reading anything, but a bot reads some channels. |
| 0 | **Not verified** | The app cannot confirm the member list, the key history or the server's identity right now. Nothing about the level above can be relied on. |
| 0 | **Updating keys** | Someone was removed and the channel's keys have not been changed yet. Sending is paused. |
| 0 | **Key changed** | (Direct messages.) This person's key is different from the one you had. Check it with them. |

The text "End-to-end encrypted" appears only at level 4. No other state may display it, abbreviate it, or use a lock or "safe" colour. Level 0 is drawn as an empty bar.

Why bots are level 1: a bot reads everything in its channel, exactly as much as a host that reads messages does. It is a visible, named member that an admin chose per channel, so the label says "Bot", not "Server". Why web is level 1: a host that alters the page reads everything that member can read, text and files, in private channels and DMs too, which no host feature can reach. That is at least as much as "Server reads messages", so ranking it above files (2) would understate it (final-check finding 11; D1: the bar never overstates). Nothing is read *by design*, but the bar is about what can be read, not what is intended. The same applies to every conversation a web user is in, so a web participant lowers the bar for everyone in the conversation (the "Member on web app" row). Why links are level 3, files level 2, messages level 1: the levels order how much a non-member can read by design.

## 2. Inputs

All inputs come from the client's own verification. If any needed input is missing, the level is 0 "Not verified".

| Input | Source |
|---|---|
| `log_verified` | The client has verified the log from genesis, its head is fresh (it contains an entry from another active member made within the last 24 hours, PROTOCOL 3.5 item 4; exempt if the viewer is the only human member), the pin matches, and no rollback or fork has been seen (PROTOCOL 3.5). |
| `features` | The latest verified `features_set` entry; all off if none (PROTOCOL 15). |
| `kind(C)` | `public`, `private`, `dm` or `gdm`, from the log or the DM objects. |
| `epoch` | The current epoch's header for channel C, verified (PROTOCOL 9.4). |
| `epoch.host.classes` | Bits T=1, F=2, U=4 in that header. 0 if `host` is null. |
| `epoch.bots` | Recipients of that header whose role in the log is `bot`. |
| `log_required_classes(C)` | Classes the verified log requires for C right now. For `public`: T if `search` is on; F if `scan` or `transcode` is on; U if `link_preview` is on. For other kinds: 0. |
| `log_bots(C)` | Bots the verified log says are in C right now. |
| `epoch_exposed(C)` | The current epoch's `recipients` include an account the verified log no longer authorises for C (removed, banned, left, replaced). |
| `epoch_alert(C)` | An epoch header was seen and rejected (unexpected recipient, unauthorised host entry, equivocation). |
| `peer_key_changed(C)` | For `dm` and `gdm`: a member's `account_id` for a remembered contact differs from the pinned one and the user has not accepted it. |
| `client` | `native` or `web`. |
| `privileged_web` | The verified log's owner or any active admin has an active device certificate with `platform = web` (PROTOCOL 3.3, "Owner and admin keys on the web client"). Same limit as `web_member`: it can only add a warning. |
| `web_member(C)` | Some account that is a member of C (for a DM or group DM, a party) has an active device certificate with `platform = web` in the certificates the server returned for it (PROTOCOL 1.2). A hostile host can withhold a certificate, so this input can only add a warning, never remove one. |

## 3. Channel level

```
factors = []

if not log_verified:           factors += (0, "Not verified")
if epoch_alert(C):             factors += (0, "Not verified")
if epoch_exposed(C):           factors += (0, "Updating keys")
if kind(C) in {dm, gdm} and peer_key_changed(C):
                               factors += (0, "Key changed")

H = epoch.host.classes  OR  log_required_classes(C)        # conservative in both directions
if H has T:                    factors += (1, "Server reads messages")
elif H has F and H has U:      factors += (2, "Server sees files, links")
elif H has F:                  factors += (2, "Server sees files")
elif H has U:                  factors += (3, "Server sees links")

if epoch.bots not empty or log_bots(C) not empty:
                               factors += (1, "Bot can read")

if client == web:              factors += (1, "Host serves this app")
if web_member(C):              factors += (1, "Member on web app")

if factors is empty:           return (4, "End-to-end encrypted")
level = min level in factors
label = the factor with that level that comes first in the order above
return (level, label)
```

Notes:

- `H` is the union of what the epoch carries and what the log requires. A feature turned **on** lowers the level the moment the client verifies the log entry, before any new epoch exists. A feature turned **off** raises the level only when the new epoch without the host entry is current. Same for bots: they count until the epoch that excludes them is current.
- Every factor that applies is listed in the detail sheet (section 6). The bar and label show only the lowest.
- If `H` has T and F but not U, the label is "Server reads messages". The detail sheet still lists files.
- Features never apply to private channels, DMs or group DMs (PROTOCOL 15.2), so `H` is 0 for them. A header that says otherwise is rejected and sets `epoch_alert`.
- Web caps every view at level 1, including DMs. A web member of the conversation caps it at level 1 for everyone in it. When a host-feature or bot factor also has level 1, its label comes first in the order above and the web factor appears in the detail sheet.

## 4. Server level

The server level covers the channels the member can see (all non-archived public channels, and private channels they are in), plus server-wide conditions. DMs are not part of it.

```
factors = []
if not log_verified:           factors += (0, "Not verified")
if client == web:              factors += (1, "Host serves this app")
if privileged_web:             factors += (1, "Admin key on web")
for each visible channel C:
    (lvl, label, all_factors) = channel_level(C)      # section 3
    for each f in all_factors: factors += f           # includes bot factors

level = min level in factors (4 if empty)
label = the lowest factor's label; ties: server-wide factors first, then host-feature factors,
        then bot factors
if the lowest factors are only "Bot can read": label = "Bots in some channels"
```

## 5. Per-epoch markers in the timeline

Each epoch has its own level, computed with section 3 from that epoch's header (host classes and bots), not from the present. Where the level changes between two epochs of a channel, the timeline shows a divider at the boundary:

- Lowered: "Messages below can be read by the server." or "…by a bot." (the specific label).
- Raised: "Messages below are end-to-end encrypted." (only when the new epoch has level 4.)

So a member scrolling old history can see which messages were exposed at the time. Messages above a boundary stay marked as exposed even after the feature is turned off: turning it off does not unread them (L11).

## 6. Detail sheet

Opened from the bar. It lists, in plain language and in this order: the label and one sentence; each factor that applies with who can read what and since when; where to change it ("Ask the server owner" for features; "An admin can remove the bot" for bots); and always this footer, whatever the level: "The server can always see who talks to whom, when, and how much. It cannot see what is said (except as listed above)."

Strings (exact; translate later):

| Condition | Sheet text |
|---|---|
| Level 4 | "Only the people in this conversation can read it, as long as everyone in it uses the app. Member keys are vouched for by this server's admins; compare safety numbers with someone to be sure. A hostile server host could try to guess the passwords of members whose accounts are not sealed and, if it guesses one, read what that member can read; this shows as level 4. Strong passwords and sealed accounts make this much harder." |
| Member on web | "<Name> uses the web version. That page came from this server's host, who could change it and read what <Name> reads, including this conversation. The host can also hide that someone uses the web version." |
| `H` has T | "The server owner turned on search. The server can read message text in public channels, from <date> on." |
| `H` has F only | "The server owner turned on <file checks / file conversion>. The server can read files and their names in public channels, from <date> on." |
| `H` has U | "The server owner turned on link previews. The server can read web addresses sent in public channels, from <date> on." |
| Bots | "<Name> is a bot in this channel, run by <operator>. It can read everything here, and so can whoever runs it, which is often the server's host<, and it may send it to: <endpoint host>>." `<operator>` is the admin whose `bot_add` enrolled it (PROTOCOL 16.1). |
| Admin key on web | "<Name>, who can change who is in this server, has used the web version. That page came from the host, who could have taken their key. Ask them to use the desktop or phone app." |
| Web | "You are using the web version. The page came from this server's host, who could change it. Use the desktop or phone app for full protection." |
| Not verified | The specific reason in plain words (see section 7), and "Don't share anything private until this clears." |
| Updating keys | "Someone was removed. Messages can't be sent until the keys are changed. This usually takes a few seconds." |
| Key changed | "<Name>'s key is different. This can happen if they got a new phone or lost their password, and it can mean someone is pretending to be them. Compare safety numbers before continuing." |

## 7. Reasons for "Not verified"

The detail sheet shows the one that applies: "can't reach the server to check", "the server's member list failed its checks", "the server's history changed", "this is not the server you joined", "the server showed different people different things", "nobody else has been seen active on this server for a day", "the server's key information doesn't match the member list", "the server shows a different setting than the signed one". The mapping from the client's internal condition to the sentence is a table in the client; every condition maps to exactly one sentence.

## 8. Notices

- When a verified `features_set` entry changes the feature set, each affected channel gets a non-dismissible notice at that log position (PROTOCOL 15.7). The level changes at the same moment.
- When a bot is added or removed, a notice says so.
- When a `key_replace` entry has no `old_proof` (an admin replaced someone's key without the old key's consent), every channel the old account was in shows a notice at that log position: "<Name> now has a new key chosen by an admin." (PROTOCOL 3.3 kind 14). When `old_id` is the owner or an admin, a notice is shown in every channel whether or not `old_proof` is present, and names the signing device (PROTOCOL 15.9).
- When the level of a channel drops, the app also shows it once on the next open of that channel as a bar-change, not only as a small icon.

## 9. Activity chips (not levels)

Plex watch parties, the Shared Browser, and other server-played streams are made by the host and are not end-to-end encrypted. While one is active in a call or channel, its panel carries a fixed chip: "Served by the host" with a sentence: "The host can see this stream. Shared Browser sign-ins are seen by the host." The chip never changes the channel level, because it covers content the host produces, not what members send. It must still be visible whenever the activity is. Gimme searches and requests carry the chip too ("The host sees what you search for").

## 10. Calls

A call has its own label because host features cannot read call media. The call bar uses section 3 with only these factors: `log_verified`, `epoch_alert`, `epoch_exposed`, bots in the channel (a bot can derive the call key), the web cap, and `web_member(C)`. The call label reads "End-to-end encrypted" only at level 4 and says "Call" in its detail sheet title. A participant who is not a member in the log is shown with "Unverified person" and is never included in a count of participants who are covered.

## 11. Fixtures every implementation must pass

Provided as TV-17. Expected results:

| State | Level, label |
|---|---|
| All features off, no bots, native, log verified, epoch ok | 4, End-to-end encrypted |
| Same, web | 1, Host serves this app |
| Same, native viewer, one other participant on web | 1, Member on web app |
| Same, private channel or DM, one other participant on web | 1, Member on web app |
| Same, native viewer, the owner has a web device certificate (server view) | 1, Admin key on web |
| `link_preview` on, public channel | 3, Server sees links |
| `scan` on, public | 2, Server sees files |
| `scan` and `link_preview` on, public | 2, Server sees files, links |
| `search` on, public | 1, Server reads messages |
| `search` on, private channel | 4, End-to-end encrypted |
| `search` on, DM | 4, End-to-end encrypted |
| `search` on, web, public | 1, Server reads messages |
| Sealed push text on (a server setting, not a host feature), public | 4, End-to-end encrypted |
| Bot in channel, no features | 1, Bot can read |
| Bot in one public channel, viewed from the server level | 1, Bots in some channels |
| `search` just turned off, current epoch still has host entry | 1, Server reads messages |
| `search` just turned off, new epoch adopted | 4, End-to-end encrypted |
| `search` just turned on (log verified), no new epoch yet | 1, Server reads messages |
| Member removed, current epoch still lists them | 0, Updating keys |
| Log rollback seen | 0, Not verified |
| Epoch header with a host entry for a DM | 0, Not verified |
| DM peer key changed, not accepted | 0, Key changed |
| Head not fresh (no entry from another member in 24 hours) while online | 0, Not verified |
| Head frozen before a removal, no fresh entry from another member | 0, Not verified |

## 12. What the level does not claim

It does not say the people in the conversation are who they claim to be, that no member will leak, that the host cannot see metadata, that the app on the device is uncompromised, that nobody in the conversation uses the web version (a hostile host can hide that), that deleted content is gone, or that the admins are honest about whom they let in. The detail sheet says so for the first and the last.
