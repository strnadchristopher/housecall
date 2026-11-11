// In-memory fixture of the Housecall HTTP API, for the UI lane only.
// It implements just enough of docs/API.md for client/src/App.tsx to drive the
// designed UI end to end in a browser. It is a mock: no auth security, no
// persistence, no media. Passing UI tests against it says nothing about the
// real Rust server. Port defaults to 3131 (engineering's fixture uses 3031).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.UI_FIXTURE_PORT ?? 3131);
const now = () => Date.now();
const users = [
  { id: 'u-owner', username: 'christopher', is_owner: true, password: 'fixture-password-owner' },
  { id: 'u-maya', username: 'maya', is_owner: false, password: 'fixture-password-maya' },
  { id: 'u-jun', username: 'jun', is_owner: false, password: 'fixture-password-jun' },
];
const sessions = new Map();
const channels = [
  { id: 'c-general', name: 'general', kind: 'channel', server_id: 'home' },
  { id: 'c-movie', name: 'movie-night', kind: 'channel', server_id: 'home' },
];
const messages = [];
const events = [];
const gimme = [];
const reports = [];
const activities = new Map();
let cursor = 0;
function seed() {
  const t = now() - 600000;
  const add = (channel_id, author_id, body, extra = {}) => messages.push({ id: randomUUID(), channel_id, author_id, body, created_at: t + messages.length * 1000, revision: 1, reply_to: null, pinned: false, reactions: [], attachments: [], ...extra });
  add('c-movie', 'u-maya', 'ok who is actually free friday');
  add('c-movie', 'u-jun', 'friday works. **not** watching anything over 2h30 though');
  add('c-movie', 'u-owner', 'Put it to a vote: Arrival, Paddington 2, The Thing', { pinned: true, reactions: [{ emoji: '👍', user_id: 'u-maya' }] });
  add('c-general', 'u-maya', 'welcome to the fixture server');
}
seed();
function emit(kind, channel_id, payload = {}) { events.push({ id: ++cursor, kind, channel_id, payload, created_at: now() }); }

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function authUser(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const s = sessions.get(token);
  if (!s || s.device_key !== req.headers['x-device-key']) return null;
  return users.find(u => u.id === s.user_id) ?? null;
}
function issue(user) {
  const token = randomUUID(), device_key = randomUUID();
  sessions.set(token, { user_id: user.id, device_key, id: randomUUID(), created_at: now() });
  return { token, device_key, expires_at: now() + 86400000, user: { id: user.id, username: user.username, is_owner: user.is_owner } };
}
const pub = u => ({ id: u.id, username: u.username, is_owner: u.is_owner });
function snapshot(channel_id, kind) {
  return { kind, revision: 1, server_time_ms: now(), host: 'u-owner', members: ['u-owner'], playback: { media_id: null, playing: false, position_ms: 0, anchored_at_ms: now(), duration_ms: null }, queue: [], skip_votes: [], controller: null, control_requests: [] };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const p = url.pathname;
  const m = req.method;
  if (p === '/api/health') return json(res, 200, { ok: true, fixture: true });
  if (m === 'POST' && p === '/api/invites/accept') {
    const b = await readBody(req);
    if (!String(b.token ?? '').startsWith('fixture-invite')) return json(res, 410, { error: 'This invitation has expired or was already used' });
    if (String(b.password ?? '').length < 12) return json(res, 400, { error: 'Password must be at least 12 characters' });
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(String(b.username ?? ''))) return json(res, 400, { error: 'Usernames use letters, numbers, - and _ (2 to 32)' });
    if (users.some(u => u.username === b.username)) return json(res, 409, { error: 'That username is taken' });
    const u = { id: 'u-' + randomUUID(), username: b.username, is_owner: false, password: b.password };
    users.push(u); emit('member.joined', null);
    return json(res, 200, issue(u));
  }
  if (m === 'POST' && (p === '/api/login' || p === '/api/setup')) {
    const b = await readBody(req);
    const u = users.find(x => x.username === b.username);
    if (!u || u.password !== b.password) return json(res, 401, { error: 'Invalid username or password' });
    return json(res, 200, issue(u));
  }
  const me = authUser(req);
  if (!me) return json(res, 401, { error: 'Sign in required' });
  let mm;
  if (m === 'GET' && p === '/api/me') return json(res, 200, { user: pub(me), capabilities: { passkeys: true, giphy: false, plex: false, dj: false, activity_sync: true, gimme_dry_run: true } });
  if (m === 'GET' && p === '/api/channels') return json(res, 200, { channels });
  if (m === 'POST' && p === '/api/channels') {
    const b = await readBody(req);
    const ch = { id: randomUUID(), name: b.name, kind: b.kind ?? 'channel', server_id: b.kind === 'channel' ? (b.server_id ?? 'home') : null };
    channels.push(ch); emit('channel.created', ch.id); return json(res, 200, ch);
  }
  if (m === 'GET' && p === '/api/members') return json(res, 200, { members: users.map(pub) });
  if (m === 'GET' && p === '/api/notifications') return json(res, 200, { notifications: [] });
  if (m === 'GET' && p === '/api/events') {
    const after = Number(url.searchParams.get('after') ?? 0);
    return json(res, 200, { events: events.filter(e => e.id > after), cursor });
  }
  if (m === 'GET' && p === '/api/devices') return json(res, 200, { devices: [...sessions.entries()].filter(([, s]) => s.user_id === me.id).map(([t, s]) => ({ id: s.id, device_name: 'Housecall browser', created_at: s.created_at, expires_at: s.created_at + 86400000, current: t === (req.headers.authorization ?? '').slice(7) })) });
  if (m === 'DELETE' && (mm = /^\/api\/devices\/([^/]+)$/.exec(p))) { for (const [t, s] of sessions) if (s.id === mm[1]) sessions.delete(t); return json(res, 204); }
  if (m === 'GET' && p === '/api/servers') return json(res, 200, { servers: [{ id: 'home', name: 'Home', general_channel_id: 'c-general' }] });
  if (m === 'GET' && /^\/api\/servers\/[^/]+\/roles$/.test(p)) return json(res, 200, { roles: [{ id: 'r-crew', name: 'movie crew', member_ids: ['u-maya', 'u-jun'] }] });
  if (m === 'GET' && p === '/api/reports') return json(res, 200, { reports });
  if (m === 'POST' && p === '/api/reports') { const b = await readBody(req); const r = { id: randomUUID(), kind: b.kind, body: b.body, status: 'open', logs: b.logs_consent ? b.logs : null, screenshot_id: null }; reports.push(r); return json(res, 200, { id: r.id }); }
  if (m === 'PATCH' && (mm = /^\/api\/reports\/([^/]+)$/.exec(p))) { const r = reports.find(x => x.id === mm[1]); if (r) r.status = 'resolved'; return json(res, 200, r ?? {}); }
  if (m === 'POST' && p === '/api/invites') return json(res, 200, { token: 'fixture-invite-' + randomUUID() });
  if ((mm = /^\/api\/channels\/([^/]+)\/messages$/.exec(p))) {
    const cid = mm[1];
    if (m === 'GET') {
      let list = messages.filter(x => x.channel_id === cid);
      if (url.searchParams.get('pinned') === 'true') list = list.filter(x => x.pinned);
      const q = url.searchParams.get('q');
      if (q) list = list.filter(x => x.body.toLowerCase().includes(q.toLowerCase()));
      return json(res, 200, { messages: list });
    }
    const b = await readBody(req);
    const msg = { id: randomUUID(), channel_id: cid, author_id: me.id, body: String(b.body ?? ''), created_at: now(), revision: 1, reply_to: b.reply_to ?? null, pinned: false, reactions: [], attachments: [] };
    messages.push(msg); emit('message.created', cid, { message_id: msg.id }); return json(res, 200, msg);
  }
  if ((mm = /^\/api\/messages\/([^/]+)$/.exec(p))) {
    const i = messages.findIndex(x => x.id === mm[1]);
    if (i < 0) return json(res, 404, { error: 'Not found' });
    if (m === 'DELETE') { const [gone] = messages.splice(i, 1); emit('message.deleted', gone.channel_id, { message_id: gone.id }); return json(res, 204); }
    if (m === 'PATCH') { const b = await readBody(req); messages[i] = { ...messages[i], body: String(b.body), revision: messages[i].revision + 1 }; emit('message.updated', messages[i].channel_id, { message_id: messages[i].id }); return json(res, 200, messages[i]); }
  }
  if (m === 'POST' && (mm = /^\/api\/messages\/([^/]+)\/(reactions|pin)$/.exec(p))) {
    const msg = messages.find(x => x.id === mm[1]);
    if (!msg) return json(res, 404, { error: 'Not found' });
    const b = await readBody(req);
    if (mm[2] === 'pin') msg.pinned = !!b.pinned; else msg.reactions.push({ emoji: b.emoji, user_id: me.id });
    msg.revision++; emit('message.updated', msg.channel_id, { message_id: msg.id }); return json(res, 200, msg);
  }
  if (m === 'POST' && /^\/api\/channels\/[^/]+\/(typing|read)$/.test(p)) return json(res, 204);
  if ((mm = /^\/api\/channels\/([^/]+)\/gimme\/requests$/.exec(p))) {
    if (m === 'GET') return json(res, 200, { requests: gimme.filter(g => g.channel_id === mm[1]).slice().reverse() });
    const b = await readBody(req);
    const g = { id: randomUUID(), channel_id: mm[1], user_id: me.id, request: b.request, state: 'complete', dry_run: true, provider_verified: false, result_status: null, result: null, confirmation_required: false, error_code: null, retryable: false, provider_outcome_unknown: false, provider_job_id: null, polling_paused: false, created_at: now(), updated_at: now() };
    gimme.push(g); emit('gimme.request.updated', mm[1]); return json(res, 200, { dry_run: true, provider_verified: false, operation: { state: 'dry_run' }, request: g });
  }
  if ((mm = /^\/api\/channels\/([^/]+)\/activity$/.exec(p))) {
    const cid = mm[1];
    if (m === 'GET') return activities.has(cid) ? json(res, 200, activities.get(cid)) : json(res, 404, { error: 'No activity' });
    if (m === 'POST') { const b = await readBody(req); const s = snapshot(cid, b.kind); activities.set(cid, s); emit('activity.updated', cid, s); return json(res, 200, s); }
    if (m === 'DELETE') { activities.delete(cid); emit('activity.stopped', cid); return json(res, 204); }
  }
  if (m === 'POST' && (mm = /^\/api\/channels\/([^/]+)\/activity\/commands$/.exec(p))) {
    const s = activities.get(mm[1]);
    if (!s) return json(res, 404, { error: 'No activity' });
    const { command } = await readBody(req);
    if (command.type === 'play') s.playback.playing = true;
    if (command.type === 'pause') s.playback.playing = false;
    if (command.type === 'seek') s.playback.position_ms = command.position_ms;
    if (command.type === 'select') { s.playback.media_id = command.media_id; s.playback.duration_ms = command.duration_ms; }
    if (command.type === 'enqueue') s.queue.push({ id: command.track.id, title: command.track.title });
    if (command.type === 'request_control') s.controller = { user_id: me.id, expires_at_ms: now() + 60000 };
    s.revision++; s.server_time_ms = now();
    emit('activity.updated', mm[1], s); return json(res, 200, s);
  }
  return json(res, 404, { error: `Fixture does not implement ${m} ${p}` });
});
server.listen(PORT, '127.0.0.1', () => console.log(`UI fixture API on http://127.0.0.1:${PORT}`));
