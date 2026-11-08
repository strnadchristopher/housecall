# UI requests to engineering (from the Opus UI lane)

The designed UI (`client/src/ui/**`, branch `ui`) runs on the current v1 contract with **no changes to `App.tsx` or any engineering file**. Where the contract only hands presentation a `text` string, `client/src/ui/parse.ts` recovers structure from the exact strings `App.tsx` builds, and always falls back to the raw text. Each item below removes a parser, a workaround or a limitation. All of them are optional, and the UI keeps working without any of them.

Two invariants the UI keeps, which engineering can rely on:
- **Contract shape:** test ids, action accessible names, field labels and names, `li[data-item-id]`, and `item.text` contained in each row's text are all unchanged.
- **E2E compatibility:** it was not possible to run the engineering E2E suite from the UI lane, because the server build is a heavy native compile. Noah should run `client/tests/e2e/*.spec.ts` against this branch with a built server.

## R-1 Structured message items

**Today:** messages arrive as `"user: body (reply) (pinned) 👍"`, so the UI parses author, flags and reactions from text.

**Proposed:** add optional fields to `Item` for conversation rows:

```ts
message?: {
  authorId: string; authorName: string; createdAt: number; editedAt?: number;
  replyTo?: { id: string; authorName: string; excerpt: string } | null;
  pinned: boolean; reactions: { emoji: string; count: number; mine: boolean }[];
  attachments: { id: string; filename: string; length: string; videoPath?: string; thumbnailPath?: string }[];
  mentionsMe: boolean;
}
```

**Unlocks:** timestamps, day dividers, reply previews with jump-to, reaction toggles, image thumbnails, and an exact "mentions me" highlight. The UI currently infers that from the shell title username.

## R-2 Shell: channel kinds, current channel, unread and mention counts

**Today:** channel items are `{ text: name }`, so the UI cannot separate DMs from channels or show unread state. "Current channel" is matched by title.

**Proposed:**

```ts
channel?: { kind: 'channel'|'dm'|'group_dm'; serverId?: string; current: boolean; unread: number; mentions: number }
```

## R-3 Label wording

The labels are accessible names, and the E2E suite depends on them, so the UI keeps them verbatim. Proposed wording, to change in `App.tsx` and the tests together:

| Today | Proposed |
|---|---|
| Capabilities | Settings (the screen holds theme choice now) |
| Activity controls | Watch and listen |
| Giphy picker | GIFs |
| Control command (select, enqueue, seek, handoff) | Hide behind a host-only "Advanced" section; see R-6 |

The em dashes in status copy (Gimme statuses, activity titles, the shell title separator) are also on the design law's list of tells. Proposed: replace them with a colon or a full stop.

## R-4 Composer

1. **Multiline.** `App.tsx` tracks the draft only from `<input name="body">` (`instanceof HTMLInputElement`), so the composer cannot be a textarea. Shift+Enter newlines need App to accept a textarea as well.
2. **Pending attachments.** Expose `attachments: {id, filename}[]` on the composer screen so the UI can show what will be sent, with a remove action.
3. **Slash commands.** The UI routes `/gimme movie|show <title>` to the existing `gimme` submit intent. A `/dj <query or link>` command would need an intent that queues directly from the conversation.

## R-5 Voice

1. **Audio-only join.** `join` always captures the camera. Proposed: separate `join-audio` and `camera-on`/`camera-off` actions.
2. **Peer identity.** Remote `MediaStream`s are not mapped to users, so tiles read "Stream 1". Expose `{ streamId, userId, kind: 'camera'|'screen'|'audio' }`.
3. **Device pickers.** `selectDevice` in the contract inventory is not wired yet.

## R-6 Activities

**Today:** the activity screen exposes a raw seven-field command form. The UI keeps it, presented as a "Control desk" that is collapsed on phones, and adds ±10 s seek buttons that emit the existing `submit {command:'seek'}`.

**Proposed:**
- `duration_ms` and `media_id` in the snapshot item, which allows a real scrub bar;
- a host name instead of a host id;
- `controller_expires_at`, for a lease countdown in the shared VM;
- `isHost` / `canStop`;
- queue item `requested_by` and per-item vote state.

## R-7 GIFs and Plex artwork

**Today:** the GIF results and Plex items carry titles only, so the UI renders typeset tiles.

**Proposed:** add the authenticated proxied preview path to each item, the same pattern as uploaded media, so the UI can fetch it through `api.mediaRequest`.

## R-8 Notifications

Items read `Message <id>`. Proposed: add the author, the channel name and an excerpt, plus retraction status (the states in `PUSH.md`).

## R-9 Reports

Report creation silently drops logs without consent. That is correct, and the UI now warns before submit. Proposed: return a field from submit when logs were dropped, so the UI can confirm what was actually sent.

## R-10 Onboarding

1. Expose invite metadata (inviter, expiry) on the `invite` screen. The UI has room for "Christopher invited you, link expires in 6 hours".
2. Native passkey support. On the invite screen, the UI already shows "Sign in with passkey" only as a secondary option.


## Recovery engineering handoff — native, message data and voice inputs

Engineering supplied optional structured `Item.message`, `Item.channel`, `Item.activity`, `Item.queue` and `ScreenProps.attachments` in contracts/ui.ts; existing text/labels remain compatible. Exact mention IDs, grouped reactions, visible-conversation replies and filename/removal data are available. Opus adoption remains required.

Voice adds `join-audio` and `refresh-devices` action descriptors plus `ScreenProps.voice.inputs`/`selected`. Emit `select-inputs` with `values.microphone` and `values.camera` device IDs before joining; existing `join` still requests camera+microphone and `join-audio` explicitly requests microphone only. Enumeration does not prompt for permission and labels may be blank. Current VoiceScreen hardcodes its actions and renders only bitrate/noise controls, so it does not yet expose these new contracts. Please render the audio-only action and device selection; do not infer actual device availability from configuration. Six transport lifecycle regressions pass; physical/native capture remains a separate gate.

VM input is available through `vm` intents `key`, `pointer`, `click` documented in VM.md. No VM media stream is advertised; capture/audio/reset integration remains open. Native authentication/invitation and background-notification permission/error states use existing intents/errors with device verification limits in NATIVE-AUTH.md and NATIVE-PUSH.md.

Recovery v16 clarification: VM start/stop media actions are supplied only for VM activities and are rendered by the existing generic Page action contract. Do not treat these two descriptors as awaiting implementation; their real-server behavior remains unverified. Optional `vm` metadata binds SFU source IDs to received stream IDs for future Opus-owned source staging. Audio-only/input-device controls, structured message metadata adoption and VM pointer/keyboard presentation still need presentational integration. Safe app-driven snapshot reset remains backend/source work as well as a UI flow; it is not a completed control hidden by the UI.
