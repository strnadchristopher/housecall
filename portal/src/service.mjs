import { createServer } from 'node:http';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { Limits, peerIP } from './limits.mjs';
import { envelope, decode } from './vault.mjs';
import { staticRequest, reply, headers, configureHTTP } from './http.mjs';
const random = () => randomBytes(32).toString('base64url');
const digest = s => createHash('sha256').update(s).digest('hex');
export function username(value) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Invalid username');
  const normalized = value.normalize('NFKC').toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) throw new Error('Invalid username');
  return normalized;
}
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.sort().join(',')) throw new Error('Invalid fields');
}
function wire(s) { decode(s, 1, 2048); return s; }
function fail(status, error) { return Object.assign(new Error(error), { status, safe: error }); }
function expectedAccount(binding, account) {
  decode(binding, 32, 32);
  if (binding !== account.binding) throw Object.assign(fail(409, 'Account changed in another tab. Log in again.'), { code: 'account_changed' });
}
async function body(req, cap) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw fail(415, 'Use JSON.');
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > cap)) throw fail(413, 'Payload too large.');
  let size = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(), 10000); timer.unref();
  try {
    for await (const chunk of req) { size += chunk.length; if (size > cap) throw fail(413, 'Payload too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}
/** Inject the actual installed OPAQUE module, never a substitute. */
export function createPortal({ opaque, store, setup, indexKey, origin, registrationOpen = false, proxy = false, now = () => performance.now(), exchangeTTL = 60000, sessionTTL = 1800000, directory = null }) {
  if (new URL(origin).origin !== origin || !(origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) throw new Error('Invalid public origin');
  opaque.server.getPublicKey(setup); // Fail startup on invalid/missing persistent setup.
  decode(indexKey, 32, 32);
  const probe = opaque.client.startLogin({ password: random() }).startLoginRequest;
  const limits = new Limits(now), pending = new Map(), sessions = new Map();
  let active = 0;
  const index = name => createHmac('sha256', Buffer.from(indexKey, 'base64url')).update('housecall portal username v1\0' + name).digest('hex');
  function sweep() { for (const map of [pending, sessions]) for (const [key, row] of map) if (row.until <= now()) map.delete(key); }
  const sweepTimer = setInterval(sweep, 15000); sweepTimer.unref();
  function exchange(row) {
    if (pending.size >= 128) throw fail(503, 'Account service busy. Retry shortly.');
    const id = random(); pending.set(digest(id), { ...row, until: now() + exchangeTTL }); return id;
  }
  function consume(id, type) {
    const key = digest(wire(id)), row = pending.get(key); pending.delete(key);
    if (!row || row.type !== type || row.until <= now()) throw fail(401, 'Exchange expired or invalid. Start again.');
    return row;
  }
  function session(req) {
    const cookies = req.headers.cookie || '';
    if (cookies.length > 4096) throw fail(401, 'Log in again.');
    const matches = [...cookies.matchAll(/(?:^|;\s*)__Host-hc=([A-Za-z0-9_-]{43})(?=;|$)/g)];
    if (matches.length !== 1) throw fail(401, 'Log in again.');
    const key = digest(matches[0][1]), row = sessions.get(key);
    if (!row || row.until <= now() || !store.accounts.has(row.index)) { sessions.delete(key); throw fail(401, 'Log in again.'); }
    return { key, row };
  }
  const cookie = (res, value, maxAge) => res.setHeader('Set-Cookie', `__Host-hc=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    if (directory && (req.url === '/api/directory/publish' || req.url?.startsWith('/api/directory?') || req.url === '/api/directory')) {
      headers(res);
      try {
        if (!limits.allow(peerIP(req, proxy))) throw new Error();
        if (req.method === 'POST' && req.url === '/api/directory/publish') return reply(res, 200, await directory.publish(await body(req, 4096)));
        if (req.method !== 'GET' || req.url.startsWith('/api/directory/publish')) throw new Error();
        const url = new URL(req.url, origin);
        if ([...url.searchParams.keys()].some(k => !['q', 'offset'].includes(k))) throw new Error();
        return reply(res, 200, directory.search(url.searchParams.get('q') || '', Number(url.searchParams.get('offset') || 0)));
      } catch { return reply(res, 400, { error: 'Directory request refused. Check DNS ownership and retry.' }); }
    }
    if (!req.url?.startsWith('/api/account')) return staticRequest(req, res);
    headers(res);
    try {
      if (++active > 64) throw fail(503, 'Account service busy. Retry shortly.');
      if ((req.headers.origin !== origin && !(req.method === 'GET' && req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin')) || req.headers['x-housecall'] !== '1' || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw fail(403, 'Request origin refused.');
      if (!limits.allow(peerIP(req, proxy))) throw fail(429, 'Too many requests. Retry in a minute.');
      sweep();
      if (store.broken) throw fail(503, 'Account storage unavailable. Retry after operator repair.');
      const path = req.url, method = req.method;
      if (path.includes('?') || path.includes('#')) throw fail(400, 'Invalid request.');
      if (path === '/api/account/status' && method === 'GET') return reply(res, 200, { registrationOpen });
      const v = ['POST', 'PUT', 'DELETE'].includes(method) ? await body(req, path === '/api/account/vault' ? 98304 : 32768) : undefined;
      if (path === '/api/account/register/start' && method === 'POST') {
        if (!registrationOpen) throw fail(503, 'Registration is closed pending review. Direct connection remains available.');
        fields(v, ['username', 'registrationRequest']); const name = username(v.username), id = index(name);
        if (store.accounts.has(id)) throw fail(409, 'Username unavailable.');
        if (store.accounts.size >= 1000) throw fail(503, 'Registration capacity reached.');
        const result = opaque.server.createRegistrationResponse({ serverSetup: setup, userIdentifier: id, registrationRequest: wire(v.registrationRequest) });
        return reply(res, 200, { exchange: exchange({ type: 'register', index: id }), registrationResponse: result.registrationResponse });
      }
      if (path === '/api/account/register/finish' && method === 'POST') {
        fields(v, ['exchange', 'registrationRecord']); const row = consume(v.exchange, 'register');
        if (!registrationOpen) throw fail(503, 'Registration is closed pending review.');
        if (store.accounts.has(row.index)) throw fail(409, 'Username unavailable.');
        if (store.accounts.size >= 1000) throw fail(503, 'Registration capacity reached.');
        const record = wire(v.registrationRecord);
        // Parse/validate the uploaded OPAQUE record with the library before persistence.
        opaque.server.startLogin({ serverSetup: setup, userIdentifier: row.index, registrationRecord: record, startLoginRequest: probe });
        store.set(row.index, { binding: random(), record, revision: 0, envelope: null });
        return reply(res, 201, { ok: true });
      }
      if (path === '/api/account/login/start' && method === 'POST') {
        fields(v, ['username', 'startLoginRequest']); const name = username(v.username), id = index(name);
        const result = opaque.server.startLogin({ serverSetup: setup, userIdentifier: id, registrationRecord: store.accounts.get(id)?.record ?? null, startLoginRequest: wire(v.startLoginRequest), identifiers: { client: name, server: origin } });
        return reply(res, 200, { exchange: exchange({ type: 'login', index: id, state: result.serverLoginState, name }), loginResponse: result.loginResponse });
      }
      if (path === '/api/account/login/finish' && method === 'POST') {
        fields(v, ['exchange', 'finishLoginRequest']); const row = consume(v.exchange, 'login');
        try { opaque.server.finishLogin({ serverLoginState: row.state, finishLoginRequest: wire(v.finishLoginRequest), identifiers: { client: row.name, server: origin } }); }
        catch { throw fail(401, 'Incorrect username or password.'); }
        const account = store.accounts.get(row.index);
        if (!account) throw fail(401, 'Incorrect username or password.');
        if (sessions.size >= 512) throw fail(503, 'Account service busy. Retry shortly.');
        try { sessions.delete(session(req).key); } catch { /* No previous authenticated session. */ }
        const id = random(); sessions.set(digest(id), { index: row.index, until: now() + sessionTTL, authenticated: now() });
        cookie(res, id, Math.floor(sessionTTL / 1000));
        return reply(res, 200, { binding: account.binding, revision: account.revision });
      }
      const auth = session(req), account = store.accounts.get(auth.row.index);
      if (path === '/api/account/logout' && method === 'POST') {
        fields(v, []); sessions.delete(auth.key); cookie(res, '', 0); return reply(res, 200, { ok: true });
      }
      if (path === '/api/account/vault' && method === 'GET') return reply(res, 200, { binding: account.binding, revision: account.revision, envelope: account.envelope });
      if (path === '/api/account/vault' && method === 'PUT') {
        fields(v, ['expectedBinding', 'expectedRevision', 'envelope']);
        expectedAccount(v.expectedBinding, account); envelope(v.envelope);
        if (!Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 0) throw fail(400, 'Invalid revision.');
        if (v.expectedRevision !== account.revision) throw fail(409, 'Saved list changed. Reload the saved list before editing.');
        if (account.revision >= Number.MAX_SAFE_INTEGER) throw fail(409, 'Revision limit reached. Export your list.');
        const revision = account.revision + 1;
        store.set(auth.row.index, { ...account, revision, envelope: v.envelope });
        return reply(res, 200, { revision });
      }
      if (path === '/api/account/' && method === 'DELETE') {
        fields(v, ['expectedBinding', 'confirmation']);
        expectedAccount(v.expectedBinding, account);
        if (v.confirmation !== 'DELETE' || now() - auth.row.authenticated > 300000) throw fail(403, 'Log in again, then explicitly confirm deletion.');
        store.delete(auth.row.index);
        for (const [key, s] of sessions) if (s.index === auth.row.index) sessions.delete(key);
        for (const [key, e] of pending) if (e.index === auth.row.index) pending.delete(key);
        cookie(res, '', 0); return reply(res, 200, { ok: true });
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      // Never interpolate an exception, payload, path, username, IP or library error.
      if (!res.headersSent && !res.destroyed) reply(res, error.status || (store.broken ? 503 : 400), { error: error.safe || (store.broken ? 'Account storage unavailable. Retry after operator repair.' : 'Request rejected. Retry or start again.'), ...(error.code === 'account_changed' ? { code: error.code } : {}) });
    } finally { active--; }
  });
  configureHTTP(server);
  server.on('close', () => { clearInterval(sweepTimer); pending.clear(); sessions.clear(); });
  return server;
}
