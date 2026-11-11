/**
 * Workbench fixtures. Every object here mirrors the exact ScreenProps that
 * client/src/App.tsx builds (same ids, labels, field names and item text
 * formats), filled with made-up data for design review. Nothing here is real
 * user data, and nothing here is evidence of a working backend.
 */
import type { Action, Field, Item, Phase, ScreenId, ScreenProps } from '../../contracts/ui';
import { markdownTokens } from '../../data/markdown';

type P = Omit<ScreenProps, 'onIntent'>;
export interface Scene { name: string; note: string; signedIn: boolean; screens: P[]; streams?: number; media?: 'plex' | 'video' | 'dj'; drawer?: boolean }

const ME = 'christopher';
const back: Action = { id: 'back', label: 'Back to conversation' };

function shell(opts: { owner?: boolean; phase?: Phase; dryRun?: boolean; channels?: string[] } = {}): P {
  const owner = opts.owner ?? true;
  const channels = opts.channels ?? ['general', 'movie-night', 'games', 'Maya', 'Weekend plans'];
  return {
    id: 'shell', title: `Housecall — ${ME}`, phase: opts.phase ?? 'ready',
    items: channels.map((name, i) => ({ id: `ch${i}`, text: name, actions: [{ id: 'select', label: `Open ${name}` }] })),
    actions: [
      { id: 'direct-messages', label: 'New DM' },
      { id: 'servers-admin', label: 'Servers' },
      ...(owner ? [{ id: 'channels-admin', label: 'Create channel' }, { id: 'roles-admin', label: 'Manage roles' }] : []),
      { id: 'members', label: 'Members' },
      { id: 'search', label: 'Search' },
      { id: 'pins', label: 'Pins' },
      { id: 'devices', label: 'Devices' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'report', label: 'Report a problem' },
      { id: 'settings', label: 'Capabilities' },
      { id: 'uploads', label: 'Upload file' },
      { id: 'gifs', label: 'Giphy picker' },
      { id: 'voice', label: 'Voice and video' },
      { id: 'activities', label: 'Activity controls' },
      { id: 'gimme', label: opts.dryRun === false ? 'Gimme request' : 'Gimme request (dry run)' },
      ...(owner ? [{ id: 'invites-admin', label: 'Issue invitation' }, { id: 'reports-admin', label: 'Review reports' }] : []),
      { id: 'logout', label: 'Sign out' },
    ],
  };
}

interface Msg { id: string; author: string; body: string; reply?: boolean; pinned?: boolean; reactions?: string[]; video?: string; mine?: boolean }
function message(m: Msg): Item {
  const mine = m.author === ME;
  return {
    id: m.id,
    richText: markdownTokens(m.body),
    text: `${m.author}: ${m.body}${m.reply ? ' (reply)' : ''}${m.pinned ? ' (pinned)' : ''}${(m.reactions ?? []).map(r => ` ${r}`).join('')}`,
    actions: [
      ...(m.video ? [{ id: `play-attachment:a-${m.id}`, label: `Play ${m.video}` }] : []),
      { id: 'reply', label: 'Reply' },
      ...(/https:\/\//.test(m.body) ? [{ id: 'preview-link', label: 'Preview link' }] : []),
      { id: 'react', label: 'React 👍' },
      { id: 'pin', label: m.pinned ? 'Unpin' : 'Pin' },
      ...(mine ? [{ id: 'edit', label: 'Edit' }] : []),
      { id: 'unsend', label: 'Unsend' },
    ],
  };
}

const CHAT: Msg[] = [
  { id: 'm1', author: 'maya', body: 'ok who is actually free friday' },
  { id: 'm2', author: 'maya', body: 'I can host, the projector finally works' },
  { id: 'm3', author: 'jun', body: 'friday works. **not** watching anything over 2h30 though', reactions: ['😂', '😂'] },
  { id: 'm4', author: ME, body: 'Put it to a vote. Candidates so far:\n\n- Arrival\n- Paddington 2\n- The Thing', pinned: true, reactions: ['👍', '👍', '👍'] },
  { id: 'm5', author: 'priya', body: 'Paddington 2 is the correct answer and I will not be taking questions', reply: true, reactions: ['🔥'] },
  { id: 'm6', author: 'sam', body: '@christopher can you put the 4K copy of Arrival on plex? the old one has the audio drift' },
  { id: 'm7', author: ME, body: 'Already asked Gimme. Status is up top. Here is the trailer meanwhile https://example.com/arrival-trailer' },
  { id: 'm8', author: 'jun', body: 'recorded the boss fight from last night', video: 'boss-fight-final.mp4' },
  { id: 'm9', author: 'noor', body: 'that ending 💀' },
];

function conversation(opts: { phase?: Phase; msgs?: Msg[]; typing?: string[]; gimme?: string[]; video?: boolean; error?: string; title?: string } = {}): P {
  return {
    id: 'conversation', title: opts.title ?? 'movie-night', phase: opts.phase ?? 'ready', error: opts.error,
    actions: [{ id: 'read', label: 'Mark read' }, ...(opts.video ? [{ id: 'close-video', label: 'Close video' }] : [])],
    items: [
      ...(opts.typing ?? []).map(u => ({ id: `typing-${u}`, text: `${u} is typing…` })),
      ...(opts.msgs ?? CHAT).map(message),
      ...(opts.gimme ?? []).map((t, i) => ({ id: `gimme-g${i}`, text: t })),
    ],
  };
}

function composer(opts: { mode?: 'new' | 'reply' | 'edit'; draft?: string; candidates?: { id: string; name: string; role?: boolean }[]; phase?: Phase } = {}): P {
  const mode = opts.mode ?? 'new';
  return {
    id: 'composer', title: mode === 'edit' ? 'Edit message' : mode === 'reply' ? 'Reply to message' : 'Message', phase: opts.phase ?? 'ready',
    fields: [{ name: 'body', label: 'Message', value: opts.draft ?? '', required: true }],
    items: (opts.candidates ?? []).map(c => c.role
      ? { id: `role-${c.id}`, text: `@${c.name} (role)`, actions: [{ id: 'mention-role', label: `Mention role ${c.name}` }] }
      : { id: c.id, text: `@${c.name}`, actions: [{ id: 'mention', label: `Mention ${c.name}` }] }),
    submitLabel: mode === 'edit' ? 'Save edit' : 'Send',
    actions: mode !== 'new' ? [{ id: 'cancel', label: 'Cancel' }] : [],
  };
}

const page = (p: Omit<P, 'actions'> & { actions?: Action[] }): P => ({ ...p, actions: [...(p.actions ?? []), back] });

function auth(view: 'login' | 'invite' | 'setup', error?: string): P {
  const fields: Field[] = [
    { name: 'server_origin', label: 'Server URL (blank for this server)', value: '' },
    ...(view === 'setup' ? [{ name: 'setup_token', label: 'Setup token', type: 'password' as const, required: true }] : []),
    ...(view === 'invite' ? [{ name: 'token', label: 'Invite token', type: 'password' as const, value: 'fixture-invite-token', required: true }] : []),
    { name: 'username', label: 'Username', required: true },
    { name: 'password', label: 'Password (at least 12 characters)', type: 'password', required: true },
  ];
  return {
    id: view, phase: 'ready', error,
    title: view === 'setup' ? 'Initialize Housecall' : view === 'invite' ? 'Accept invitation' : 'Sign in to Housecall',
    fields, submitLabel: view === 'setup' ? 'Initialize' : view === 'invite' ? 'Join' : 'Sign in',
    actions: [{ id: 'passkey', label: 'Sign in with passkey' }, { id: 'login', label: 'Sign in' }, { id: 'invite', label: 'Use invitation' }, { id: 'setup', label: 'First-run setup' }],
  };
}

const voiceFields: Field[] = [
  { name: 'bitrate', label: 'Opus target bitrate', type: 'number', value: '510000' },
  { name: 'noise_suppression', label: 'Noise suppression (optional)', type: 'checkbox' },
];
function voice(phase: 'idle' | 'connecting' | 'live' | 'failed', muted = false, extra = ''): P {
  const live = phase === 'live';
  return {
    id: 'voice', title: 'Voice and video', phase: phase === 'failed' ? 'error' : phase === 'connecting' ? 'loading' : 'ready',
    items: [{ id: 'status', text: `${phase}; received ${live ? 18734221 : 0} bytes; decoded ${live ? 4412 : 0} frames${extra}` }],
    fields: voiceFields, submitLabel: 'Apply audio preferences',
    actions: [
      { id: 'join', label: 'Join with microphone and camera', disabled: live || phase === 'connecting' },
      { id: 'leave', label: 'Leave voice', disabled: phase === 'idle' },
      { id: 'share', label: 'Share screen (replaces camera; microphone audio)', disabled: !live },
      { id: 'mute', label: muted ? 'Unmute' : 'Mute', disabled: !live },
      back,
    ],
  };
}

const deskFields: Field[] = [
  { name: 'command', label: 'Control command (select, enqueue, seek, handoff)', value: 'select' },
  { name: 'media_id', label: 'Plex item ID' },
  { name: 'duration_ms', label: 'Duration in milliseconds', type: 'number', value: '60000' },
  { name: 'title', label: 'Track title' },
  { name: 'source', label: 'Track link' },
  { name: 'user_id', label: 'Handoff user ID' },
  { name: 'position_ms', label: 'Seek position in milliseconds', type: 'number' },
];
function activity(kind: 'plex' | 'dj' | 'vm', opts: { playing?: boolean; position?: number; controller?: string; queue?: string[]; error?: string; host?: boolean; manifest?: boolean } = {}): P {
  const title = kind === 'plex' ? 'Plex watch party' : kind === 'dj' ? 'DJ Steve Forever — synthetic voice' : 'Activity control state — provider playback unavailable';
  return {
    id: 'activities', title, phase: 'ready',
    items: [
      { id: 'snapshot', text: `${kind} revision ${kind === 'dj' ? 41 : 17}; ${opts.playing ? 'playing' : 'paused'}; position ${opts.position ?? 0}; controller ${opts.controller ?? 'none'}` },
      ...(opts.queue ?? []).map((t, i) => ({ id: `q${i}`, text: t })),
      ...(opts.error ? [{ id: `${kind}-error`, text: opts.error }] : []),
    ],
    fields: deskFields.map(f => f.name === 'command' ? { ...f, value: kind === 'plex' ? 'select' : kind === 'dj' ? 'enqueue' : 'handoff' } : f),
    submitLabel: 'Apply control command',
    actions: [
      { id: 'browse-dj', label: 'Search songs', disabled: kind !== 'dj' },
      { id: 'browse-plex', label: 'Browse Plex library', disabled: kind !== 'plex' },
      { id: 'subtitles', label: 'Show subtitles', disabled: kind !== 'plex' || !opts.manifest },
      { id: 'play', label: 'Play' }, { id: 'pause', label: 'Pause' },
      { id: 'vote_skip', label: 'Vote to skip', disabled: kind !== 'dj' },
      { id: 'request_control', label: 'Request VM control', disabled: kind !== 'vm' },
      { id: 'stop', label: 'Stop activity', disabled: opts.host === false },
      back,
    ],
  };
}

const withChat = (content: P[], opts: Parameters<typeof shell>[0] = {}): P[] => [shell(opts), ...content];

export const scenes: Scene[] = [
  { name: 'login', note: 'Sign in, ready', signedIn: false, screens: [auth('login')] },
  { name: 'login-error', note: 'Sign in, wrong password', signedIn: false, screens: [auth('login', 'Invalid username or password')] },
  { name: 'invite', note: 'Invitation link opened, token filled in', signedIn: false, screens: [auth('invite')] },
  { name: 'invite-expired', note: 'Invitation expired or used', signedIn: false, screens: [auth('invite', 'This invitation has expired or was already used')] },
  { name: 'setup', note: 'First-run owner setup', signedIn: false, screens: [auth('setup')] },

  { name: 'chat', note: 'Conversation with markdown, mentions, reactions, pin, reply, video, Gimme status', signedIn: true,
    screens: withChat([conversation({ gimme: ['Arrival 2016: Preview saved — no provider request sent', 'Severance: Subscribed — episode discovery scheduled; downloads not yet verified'], typing: ['priya'] }), composer()]) },
  { name: 'chat-mention', note: 'Composer with @ autocomplete (users and a role)', signedIn: true,
    screens: withChat([conversation(), composer({ draft: 'friday at 8, @', candidates: [{ id: 'u1', name: 'maya' }, { id: 'u2', name: 'jun' }, { id: 'u3', name: 'priya' }, { id: 'r1', name: 'movie crew', role: true }] })]) },
  { name: 'chat-reply', note: 'Replying', signedIn: true, screens: withChat([conversation(), composer({ mode: 'reply' })]) },
  { name: 'chat-edit', note: 'Editing own message', signedIn: true, screens: withChat([conversation(), composer({ mode: 'edit', draft: 'Already asked Gimme. Status is up top.' })]) },
  { name: 'chat-empty', note: 'Brand-new channel', signedIn: true, screens: withChat([conversation({ msgs: [], title: 'film-club' }), composer()]) },
  { name: 'chat-offline', note: 'Event stream lost', signedIn: true, screens: withChat([conversation({ phase: 'offline' }), composer({ phase: 'offline' })], { phase: 'offline' }) },
  { name: 'chat-error', note: 'Send failed (error from API)', signedIn: true, screens: withChat([conversation({ error: 'Request failed (503)' }), composer({ draft: 'is the server ok' })]) },
  { name: 'chat-video', note: 'Uploaded video playing above the chat', signedIn: true, media: 'video', screens: withChat([conversation({ video: true }), composer()]) },
  { name: 'chat-drawer', note: 'Phone navigation drawer open', signedIn: true, drawer: true, screens: withChat([conversation(), composer()]) },
  { name: 'chat-member', note: 'Signed in as a non-owner', signedIn: true, screens: [shell({ owner: false }), conversation(), composer()] },

  { name: 'voice-idle', note: 'Call lobby', signedIn: true, screens: withChat([voice('idle')]) },
  { name: 'voice-connecting', note: 'Connecting', signedIn: true, screens: withChat([voice('connecting')]) },
  { name: 'voice-live', note: 'Live call, fixture canvas streams', signedIn: true, streams: 4, screens: withChat([voice('live')]) },
  { name: 'voice-muted', note: 'Live, muted, one stream', signedIn: true, streams: 1, screens: withChat([voice('live', true)]) },
  { name: 'voice-failed', note: 'Permission denied', signedIn: true, screens: withChat([voice('failed', false, '; NotAllowedError: Permission denied')]) },
  { name: 'call-dock', note: 'Back in chat during a call', signedIn: true, streams: 2, screens: withChat([conversation(), composer()]) },

  { name: 'activities', note: 'Launch an activity', signedIn: true, screens: withChat([page({ id: 'activities', title: 'Activity control state — provider playback unavailable', phase: 'ready', items: ['plex', 'dj', 'vm'].map(k => ({ id: k, text: k, actions: [{ id: 'start', label: `Start ${k} control session` }] })) })]) },
  { name: 'activity-plex', note: 'Watch party playing', signedIn: true, media: 'plex', screens: withChat([activity('plex', { playing: true, position: 2712000, manifest: true })]) },
  { name: 'activity-dj', note: 'DJ queue', signedIn: true, media: 'dj', screens: withChat([activity('dj', { playing: true, position: 94000, queue: ['Fleetwood Mac — Dreams', 'Khruangbin — Maria También', 'Daft Punk — Digital Love', 'Tame Impala — The Less I Know the Better'] })]) },
  { name: 'activity-vm', note: 'Shared VM, someone driving', signedIn: true, screens: withChat([activity('vm', { controller: 'jun', host: false })]) },
  { name: 'activity-error', note: 'Provider failure', signedIn: true, screens: withChat([activity('plex', { error: 'Plex is unreachable (502). Playback state is still shared.' })]) },

  { name: 'plex', note: 'Library browse', signedIn: true, screens: withChat([page({ id: 'plex', title: 'Plex library', phase: 'ready', items: [
    ...['Movies', 'TV Shows', 'Anime'].map((t, i) => ({ id: `lib${i}`, text: t, actions: [{ id: 'library', label: 'Browse library' }] })),
    ...['Arrival', 'Paddington 2', 'The Thing', 'Spirited Away', 'Heat', 'Columbo', 'Perfect Days', 'Mad Max: Fury Road', 'In the Mood for Love', 'Severance'].map((t, i) => ({ id: `it${i}`, text: `${t} (${i === 5 || i === 9 ? 'show' : 'movie'})`, actions: [{ id: 'choose', label: 'Watch together', disabled: false }] })),
  ] })]) },
  { name: 'plex-guest', note: 'Library as non-host (Watch together disabled)', signedIn: true, screens: withChat([page({ id: 'plex', title: 'Plex library', phase: 'ready', items: [
    ...['Arrival', 'Paddington 2', 'The Thing', 'Spirited Away'].map((t, i) => ({ id: `it${i}`, text: `${t} (movie)`, actions: [{ id: 'choose', label: 'Watch together', disabled: true }] })),
  ] })]) },
  { name: 'dj', note: 'DJ song search', signedIn: true, screens: withChat([page({ id: 'dj', title: 'DJ Steve Forever — synthetic placeholder voice', phase: 'ready',
    fields: [{ name: 'query', label: 'Song search or YouTube, SoundCloud, Spotify link', required: true }], submitLabel: 'Search songs',
    items: [['Dreams (2004 Remaster) — Fleetwood Mac', 257], ['Dreams — The Cranberries', 271], ['Dreams — Fleetwood Mac (Live)', 302]].map(([t, s], i) => ({ id: String(i), text: `${t} (${s} seconds)`, actions: [{ id: 'choose', label: 'Prepare and queue' }] })) })]) },
  { name: 'gifs-off', note: 'Giphy key missing', signedIn: true, screens: withChat([page({ id: 'gifs', title: 'Powered by GIPHY', phase: 'unavailable', items: [{ id: 'unavailable', text: 'The server has no Giphy API key configured.' }] })]) },
  { name: 'gifs', note: 'Giphy results (titles only in the contract)', signedIn: true, screens: withChat([page({ id: 'gifs', title: 'Powered by GIPHY', phase: 'ready', fields: [{ name: 'query', label: 'Search GIFs', required: true }],
    items: ['excited dog spinning', 'mind blown', 'slow clap', 'this is fine', 'nodding', 'popcorn eating'].map((t, i) => ({ id: `g${i}`, text: t, actions: [{ id: 'choose', label: 'Choose GIF' }] })) })]) },
  { name: 'gimme', note: 'Gimme with request history', signedIn: true, screens: withChat([page({ id: 'gimme', title: 'Gimme request — dry run only, no provider request sent', phase: 'ready',
    fields: [{ name: 'query', label: 'Movie or show', required: true }, { name: 'tv', label: 'TV show', type: 'checkbox' }], submitLabel: 'Preview request',
    items: [
      { id: 'g1', text: 'Arrival 2016: Preview saved — no provider request sent' },
      { id: 'g2', text: 'Severance: Subscribed — episode discovery scheduled; downloads not yet verified' },
      { id: 'g3', text: 'Heat: Already available in Plex' },
      { id: 'g4', text: 'Obscure 1971 thing: Gimme completed the search without a usable result' },
      { id: 'g5', text: 'The Thing 1982: Confirmation required — no download was started by Housecall' },
    ] })]) },
  { name: 'uploads-empty', note: 'Pick a file', signedIn: true, screens: withChat([page({ id: 'uploads', title: 'Resumable upload', phase: 'ready', fields: [{ name: 'file', label: 'File', type: 'file' }], submitLabel: 'Upload', items: [],
    actions: [{ id: 'pause', label: 'Pause' }, { id: 'derive', label: 'Prepare video and thumbnail', disabled: true }, { id: 'attach', label: 'Attach to message', disabled: true }] })]) },
  { name: 'uploads-progress', note: 'Multi-GB upload in flight', signedIn: true, screens: withChat([page({ id: 'uploads', title: 'Resumable upload', phase: 'ready', fields: [{ name: 'file', label: 'File', type: 'file' }], submitLabel: 'Resume upload',
    items: [{ id: 'u1', text: 'vacation-2026-full.mov: 2147483648/6442450944 bytes (uploading)' }],
    actions: [{ id: 'pause', label: 'Pause' }, { id: 'derive', label: 'Prepare video and thumbnail', disabled: true }, { id: 'attach', label: 'Attach to message', disabled: true }] })]) },
  { name: 'uploads-quarantined', note: 'Scanner blocked the file', signedIn: true, screens: withChat([page({ id: 'uploads', title: 'Resumable upload', phase: 'ready', fields: [{ name: 'file', label: 'File', type: 'file' }], submitLabel: 'Resume upload',
    items: [{ id: 'u1', text: 'definitely-not-malware.zip: 5242880/5242880 bytes (quarantined)' }],
    actions: [{ id: 'pause', label: 'Pause' }, { id: 'derive', label: 'Prepare video and thumbnail', disabled: true }, { id: 'attach', label: 'Attach to message', disabled: true }] })]) },
  { name: 'uploads-video', note: 'Upload ready, video prepared', signedIn: true, screens: withChat([page({ id: 'uploads', title: 'Resumable upload', phase: 'ready', fields: [{ name: 'file', label: 'File', type: 'file' }], submitLabel: 'Resume upload',
    items: [{ id: 'u1', text: 'boss-fight-final.mp4: 734003200/734003200 bytes (ready) — Video: running' }],
    actions: [{ id: 'pause', label: 'Pause' }, { id: 'derive', label: 'Prepare video and thumbnail', disabled: true }, { id: 'attach', label: 'Attach to message' }] })]) },
  { name: 'report', note: 'Bug report with consent', signedIn: true, screens: withChat([page({ id: 'report', title: 'Bug report or feature suggestion', phase: 'ready', submitLabel: 'Submit report', fields: [
    { name: 'body', label: 'Description', required: true }, { name: 'feature', label: 'Feature suggestion', type: 'checkbox' },
    { name: 'logs', label: 'Optional logs (review and remove secrets)' }, { name: 'logs_consent', label: 'I consent to sending the logs above', type: 'checkbox' },
    { name: 'report_screenshot', label: 'Optional screenshot (PNG, JPEG or WebP)', type: 'file' }, { name: 'screenshot_consent', label: 'I consent to sending the selected screenshot', type: 'checkbox' }] })]) },
  { name: 'report-error', note: 'Screenshot chosen without consent (transport error text)', signedIn: true, screens: withChat([page({ id: 'report', title: 'Bug report or feature suggestion', phase: 'ready', submitLabel: 'Submit report', error: 'Consent to sending the selected screenshot, or remove it.', fields: [
    { name: 'body', label: 'Description', required: true }, { name: 'feature', label: 'Feature suggestion', type: 'checkbox' },
    { name: 'logs', label: 'Optional logs (review and remove secrets)' }, { name: 'logs_consent', label: 'I consent to sending the logs above', type: 'checkbox' },
    { name: 'report_screenshot', label: 'Optional screenshot (PNG, JPEG or WebP)', type: 'file' }, { name: 'screenshot_consent', label: 'I consent to sending the selected screenshot', type: 'checkbox' }] })]) },
  { name: 'reports-admin', note: 'Owner report inbox', signedIn: true, screens: withChat([page({ id: 'reports-admin', title: 'Reports', phase: 'ready', items: [
    { id: 'r1', text: 'bug: Voice drops when I alt-tab out of a game on Windows (open) — Consented logs: [voice] ice state disconnected\n[voice] reconnect attempt 1\n[redacted sensitive log line]', actions: [{ id: 'screenshot', label: 'Download screenshot' }, { id: 'resolve', label: 'Resolve' }] },
    { id: 'r2', text: 'feature: Let the DJ take requests by voice (open)', actions: [{ id: 'resolve', label: 'Resolve' }] },
    { id: 'r3', text: 'bug: GIF picker scrolls behind the keyboard on iPhone (resolved)', actions: [{ id: 'resolve', label: 'Resolve', disabled: true }] },
  ] })]) },
  { name: 'devices', note: 'Sessions and passkeys', signedIn: true, screens: withChat([page({ id: 'devices', title: 'Device sessions', phase: 'ready',
    actions: [{ id: 'passkey', label: 'Add passkey', disabled: false }],
    items: [{ id: 'd1', text: 'Housecall browser (this device)', actions: [{ id: 'revoke', label: 'Revoke' }] }, { id: 'd2', text: 'Housecall desktop', actions: [{ id: 'revoke', label: 'Revoke' }] }, { id: 'd3', text: 'Pixel phone', actions: [{ id: 'revoke', label: 'Revoke' }] }] })]) },
  { name: 'notifications', note: 'Notification list', signedIn: true, screens: withChat([page({ id: 'notifications', title: 'Notifications', phase: 'ready', actions: [{ id: 'enable', label: 'Enable desktop notifications' }],
    items: [{ id: 'n1', text: 'Message 01JF6Q0Y1V4M7W' }, { id: 'n2', text: 'Message 01JF6Q2KDXN8B3' }] })]) },
  { name: 'notifications-empty', note: 'Nothing new', signedIn: true, screens: withChat([page({ id: 'notifications', title: 'Notifications', phase: 'ready', actions: [{ id: 'enable', label: 'Enable desktop notifications' }], items: [] })]) },
  { name: 'settings', note: 'Themes and server capabilities', signedIn: true, screens: withChat([page({ id: 'settings', title: 'Server capabilities', phase: 'ready',
    items: Object.entries({ passkeys: true, giphy: false, plex: true, dj: true, activity_sync: true, gimme_dry_run: true, push: false, voice: true }).map(([k, v]) => ({ id: k, text: `${k}: ${v ? 'available' : 'unavailable'}` })) })]) },
  { name: 'invites-admin', note: 'Invitation issued', signedIn: true, screens: withChat([page({ id: 'invites-admin', title: 'Single-use invitation', phase: 'ready',
    fields: [{ name: 'expires_in_seconds', label: 'Expires in seconds', type: 'number', value: '3600', required: true }], submitLabel: 'Create invitation',
    items: [{ id: 'issued', text: 'https://chat.littleobelisk.com/#invite=fixture-not-a-real-token-6f1c' }] })]) },
  { name: 'direct-messages', note: 'New DM picker', signedIn: true, screens: withChat([page({ id: 'direct-messages', title: 'Create direct message', phase: 'ready',
    fields: [{ name: 'name', label: 'Conversation name', required: true }, { name: 'member_ids', label: 'Member IDs (comma-separated)', required: true }],
    items: ['maya', 'jun', 'priya', 'sam', 'noor'].map((n, i) => ({ id: `u${i}`, text: `${n}: 0193f${i}a2-7c1e-7d2b-9f00-${i}c3e5a1b2d4f` })) })]) },
  { name: 'members', note: 'Member list', signedIn: true, screens: withChat([page({ id: 'members', title: 'Members', phase: 'ready',
    items: ['christopher', 'maya', 'jun', 'priya', 'sam', 'noor', 'theo', 'ines'].map((n, i) => ({ id: `u${i}`, text: `@${n}${i === 0 ? ' (owner)' : ''}` })) })]) },
  { name: 'search', note: 'Search results', signedIn: true, screens: withChat([page({ id: 'search', title: 'Search messages', phase: 'ready', fields: [{ name: 'query', label: 'Search query', required: true }], submitLabel: 'Search',
    items: [{ id: 's1', text: 'Put it to a vote. Candidates so far: Arrival, Paddington 2, The Thing' }, { id: 's2', text: 'Already asked Gimme for Arrival. Status is up top.' }] })]) },
  { name: 'pins-empty', note: 'No pins loaded yet', signedIn: true, screens: withChat([page({ id: 'pins', title: 'Pinned messages', phase: 'ready', fields: [], submitLabel: 'Load pins', items: [] })]) },
  { name: 'servers-admin', note: 'Servers', signedIn: true, screens: withChat([page({ id: 'servers-admin', title: 'Servers', phase: 'ready', fields: [{ name: 'name', label: 'New server name', required: true }], submitLabel: 'Create server',
    items: [{ id: 'home', text: 'Home: home', actions: [{ id: 'select', label: 'Open server Home' }] }, { id: 'srv2', text: 'Game nights: 0193f-games', actions: [{ id: 'select', label: 'Open server Game nights' }] }] })]) },
  { name: 'channels-admin', note: 'Create channel', signedIn: true, screens: withChat([page({ id: 'channels-admin', title: 'Create channel', phase: 'ready', submitLabel: 'Create channel',
    fields: [{ name: 'name', label: 'Channel name', required: true }, { name: 'server_id', label: 'Server ID', value: 'home' }, { name: 'member_ids', label: 'Channel member IDs (comma-separated)' }],
    items: ['christopher', 'maya', 'jun', 'priya'].map((n, i) => ({ id: `u${i}`, text: `${n}: 0193f${i}a2-7c1e` })) })]) },
  { name: 'roles-admin', note: 'Roles', signedIn: true, screens: withChat([page({ id: 'roles-admin', title: 'Roles for home', phase: 'ready', submitLabel: 'Create role or assign member',
    fields: [{ name: 'name', label: 'New role name' }, { name: 'role_id', label: 'Existing role ID (to assign)' }, { name: 'user_id', label: 'Member ID (to assign)' }],
    items: [{ id: 'r1', text: 'movie crew: r-01 (5 members)', actions: [{ id: 'delete', label: 'Delete role' }] }, { id: 'r2', text: 'raid night: r-02 (3 members)', actions: [{ id: 'delete', label: 'Delete role' }] }] })]) },
  { name: 'media', note: 'Link preview', signedIn: true, screens: withChat([page({ id: 'media', title: 'Link preview (requested by you)', phase: 'ready', items: [
    { id: 'host', text: 'example.com' }, { id: 'title', text: 'Arrival (2016) official trailer' }, { id: 'description', text: 'Linguist Louise Banks leads an elite team of investigators when gigantic spaceships touch down.' }, { id: 'url', text: 'https://example.com/arrival-trailer' }] })]) },
];

export const keyScenes = ['login', 'invite', 'chat', 'chat-mention', 'voice-live', 'activity-plex', 'activity-dj', 'plex', 'uploads-progress', 'settings', 'report', 'devices'];

export function sceneScreens(name: string): Scene | undefined { return scenes.find(s => s.name === name); }
export type { ScreenId };
