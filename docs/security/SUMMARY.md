# Housecall security: summary for the product owner

Status: this is a design, not a product. Nothing has been built or attacked yet. The design was written by a model and then reviewed on paper by a second pass, which found 31 problems; all are fixed in the documents (`REVIEW.md`). No human has audited it. Nothing here should be called "secure" in public until the attack run described below has happened.

## What members can rely on (if the design is built as written)

- **Messages, files, calls and direct messages are readable only by the people in them.** The server stores scrambled data and cannot read it.
- **The server cannot invent a message** or make one look like it came from someone else. Every message is signed by its sender.
- **The server cannot quietly add a member.** Who is in the server is decided by admins' signatures, and every app checks them before sharing any key.
- **Your password never leaves your device.** A server that does not hold your account's records cannot test guesses at it. The host does hold them, so see "What is not protected" below.
- **A removed person cannot read what is sent after they are removed.** The app changes the keys first, and refuses to send in the old ones.
- **A new device needs an OK from an old one.** Someone who steals only your password cannot get in, as long as you keep using one of your devices.
- **The label never overstates**, with the exceptions listed under "What is not protected" (a hostile host guessing a password is not visible in the label). "End-to-end encrypted" appears only when no host feature or bot can read the conversation and nobody in it is seen using the web version.

## What the host (the person running the server) can see

Always, at every level: who talks to whom, when, how often, how big the messages and files are, who was @mentioned, who is online, which calls happen and who joins them, and each person's device names and IP addresses.

| Level shown | What the host can read |
|---|---|
| **4, End-to-end encrypted** | Nothing beyond the list above. |
| **3, Server sees links** | The web addresses people send, so it can make link previews. Nothing else. |
| **1, Host serves this app / Member on web app** | Everything that web user can read, text and files, in private channels and DMs too, if the host alters their page. Not by design, but possible, so the bar shows level 1. |
| **1, Admin key on web** | The owner or an admin used the web version, so the host could have taken their key and changed who is in the server. |
| **2, Server sees files** | File contents and names, for virus scanning or conversion. Not message text. |
| **1, Server reads messages** | Message text (for search). Files too if those features are also on. Notification text no longer needs this: the host forwards the sender's signed message and the phone decrypts it. |
| **1, Bot can read** | Whoever runs the bot, which is often the host (for the project's own bot, Steve, normally the host), and whatever services it sends text to, read everything in its channels, private ones included. |
| **0, Not verified / Updating keys / Key changed** | The app cannot confirm who is in the conversation. Treat it as unsafe until it clears. |

Host features are off by default and apply to public channels only, from the moment the owner turns them on. Direct messages and private channels are never readable by the host. Turning a feature off protects new messages, not old ones: whatever the host already read stays read.

## What is not protected

- **Old messages if someone gets your account key.** There is no forward secrecy: anyone who gets into an unlocked device, or learns a member's key, can read all history that member could read.
- **Who talks to whom.** The host sees it (list above). So do the push services, for notifications.
- **What a member copies, screenshots or shares.** A removed member keeps everything they already read.
- **A hostile host and the web version.** The host serves the web page, so a hostile host can steal web users' passwords and keys, and the checking tool only catches an attack aimed at everyone, not at one person.
- **A hostile host guessing passwords.** The host always holds its own secret and every member's stored key blob, so it can try to guess any member's password offline, with no approval step and no trace. At the review's estimate that is roughly 115 GPU-days per account for a strong password, which a determined host can rent. A success gives the host that member's account key: all history and all future messages, while the member still sees level 4. The same applies to anyone who breaches the host. Mitigations: passwords must be strong (about a four-word passphrase), and an account with a registered device can be **sealed**, which removes the blob from the server (new devices then get the key from an old device). Owners and admins are sealed by default; members are an open decision.
- **A stolen owner key.** The owner's key alone turns host features on and can make the thief the owner for good. There is no ownership transfer in v1: if a stolen owner key has been used, members must move to a new server. The owner and admins must not use the web version, and the app warns when they have.
- **A compromised host key.** Turning features off protects new messages only; there is a defined procedure for a possible copy of the key (`PROTOCOL.md` 15.6) that also tells members which period may have been exposed.
- **A stolen unlocked phone or laptop** until the user runs "Secure my account" with an admin's help.
- **A host with a still-listed accomplice** can keep one person's view of the member list frozen at an old state.
- **Who someone really is, malware on a device, or the project's own release key.** Only comparing safety numbers proves "Alice" is Alice; a compromised device or release key defeats everything.

## What has not been tested

- **No code exists yet.** Every claim above is about the design. The libraries it depends on (OPAQUE, encryption, LiveKit call encryption, iOS notification decryption) still need small experiments to confirm they do what the design assumes. Two assumptions about LiveKit are unchecked.
- **The independent attack run has not happened.** After the build, a separate model attacks the running system (network attacker, malicious server, removed member, stolen password, malicious member). Results will go in `CRACK-REPORT.md`; the 30 tests are in `CRACK-PLAN.md`.
- **No human audit.** The README must say so.
- **The password-guessing speed is an estimate**, and the fixes made after the review have not themselves been reviewed.

## Decisions waiting for you

`DECISIONS.md` section E lists them. The main new ones: strong passwords are now required; a recovery phrase is not instant while any device is still registered; notification text no longer needs the host to read messages (that host access has been dropped). Open since the final check: sealing members' accounts by default, ownership transfer, a second admin signature on feature changes, and the 24-hour freshness rule (`final-check-fixes.md`).
