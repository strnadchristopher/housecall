// Synthetic origins only. HTTPS terminators belong to each independent local community.
import { createServer as httpsServer } from 'node:https';
import { createServer, request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as opaque from '../../portal/node_modules/@serenity-kit/opaque/esm/index.js';
import { createPortal } from '../../portal/src/service.mjs';
import { Store } from '../../portal/src/storage.mjs';
import { Directory } from '../../portal/src/directory.mjs';
import { startClamdFixture } from './clamd-fixture.mjs';
await opaque.ready;
const dir = mkdtempSync(join(tmpdir(), 'housecall-hosted-'));
const children = [], listeners = [];
let store, stopScan;
async function stop() {
  for (const child of children) child.kill('SIGTERM');
  for (const server of listeners) { server.closeAllConnections?.(); server.close(); }
  store?.close(); await stopScan?.(); rmSync(dir, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop().then(() => process.exit(0)));
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); listeners.push(server); });
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:alpha.fixture.org,DNS:beta.fixture.org'], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(dir, 'key')), cert: readFileSync(join(dir, 'cert')) };
  const appOrigin = 'https://127.0.0.1:43185';
  let accountsDown = false;
  const proofs = new Map();
  const directory = new Directory({ directory: dir, lookup: async name => {
    if (!proofs.has(name)) throw new Error('Fixture DNS proof absent');
    return [[proofs.get(name)]];
  } });
  writeFileSync(join(dir, 'accounts.json'), '{"schema":1,"accounts":{}}', { mode: 0o600 });
  store = new Store(dir);
  const accountService = createPortal({ opaque, store, setup: opaque.server.createSetup(), indexKey: randomBytes(32).toString('base64url'), origin: appOrigin, registrationOpen: true, proxy: true, directory });
  listeners.push(accountService);
  // Only this loopback test terminator assigns trusted synthetic client identities.
  // Never trust a browser-supplied forwarding chain or change production limits.
  const clients = new Map();
  function identify(req) {
    const id = /(?:^|;\s*)__Host-hosted-fixture=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (!id || (!clients.has(id) && clients.size >= 200)) return false;
    if (!clients.has(id)) clients.set(id, `192.0.2.${clients.size + 1}`);
    req.headers['x-forwarded-for'] = clients.get(id);
    return true;
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const app = httpsServer(tls, async (req, res) => {
    if (req.url === '/__fixture/accounts-down' && req.method === 'POST') { accountsDown = true; res.end('{}'); return; }
    if (req.url === '/__fixture/accounts-up' && req.method === 'POST') { accountsDown = false; res.end('{}'); return; }
    if (req.url?.startsWith('/api/')) {
      // Public search deliberately sends no cookies. Keep its fixture bucket
      // separate from signed publication and cookie-bound account traffic.
      if (req.method === 'GET' && (req.url === '/api/directory' || req.url.startsWith('/api/directory?'))) {
        req.headers['x-forwarded-for'] = '192.0.2.253';
      } else if (!identify(req)) { res.writeHead(400); res.end('{}'); return; }
      if (accountsDown && req.url.startsWith('/api/account')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      return accountService.emit('request', req, res);
    }
    const url = new URL(req.url, appOrigin);
    let file;
    if (url.pathname.startsWith('/__fixture/modules/')) {
      const name = url.pathname.slice('/__fixture/modules/'.length);
      if (!['account-client.mjs', 'account-identity.mjs', 'vault.mjs', 'device-vault.mjs', 'direct.mjs', 'opaque.mjs'].includes(name)) { res.writeHead(404); res.end(); return; }
      file = name === 'opaque.mjs' ? resolve('dist-hosted/opaque.mjs') : resolve('../portal/src', name);
    } else {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404); res.end(); return; }
      file = resolve('dist-hosted', relative);
    }
    try {
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https:; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      res.end(readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await listen(app, 43185);
  // Server-signed outbound publication uses a loopback-only debug test override.
  const publication = createServer((req, res) => {
    // Community publication gets its own bounded bucket, separate from browser auth/search.
    req.headers['x-forwarded-for'] = '192.0.2.254';
    accountService.emit('request', req, res);
  });
  await listen(publication, 43188);
  const socket = join(dir, 'clamd.sock'); stopScan = await startClamdFixture(socket);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HOUSECALL_|SFU_|PLEX_|GIMME_|GIPHY_|SWITCHBOARD_|PUSH_|APNS_|FCM_|DJ_|SPOTIFY_|YT_DLP_|RESEND_)/.test(key)));
  for (const [index, name] of ['alpha', 'beta'].entries()) {
    const port = 43186 + index, backend = 3038 + index, origin = `https://${name}.fixture.org:${port}`;
    const state = join(dir, name); mkdirSync(state);
    const child = spawn(process.env.HOUSECALL_TEST_BINARY ?? resolve('../target/debug/housecall-server'), [], { stdio: ['ignore', 'ignore', 'inherit'], env: {
      ...clean, HOUSECALL_BIND: `127.0.0.1:${backend}`, HOUSECALL_PUBLIC_URL: origin, HOUSECALL_ORIGIN: origin, HOUSECALL_CLIENT_ORIGINS: appOrigin,
      HOUSECALL_DATABASE: join(state, 'db.sqlite'), HOUSECALL_MEDIA_DIR: join(state, 'media'), HOUSECALL_MEDIA_KEY: '11'.repeat(32), HOUSECALL_CLAMD_SOCKET: socket,
      HOUSECALL_SETUP_TOKEN: 'synthetic-hosted-setup-at-least-32-characters', HOUSECALL_DIRECTORY_ENABLED: 'yes', HOUSECALL_TEST_DIRECTORY_URL: 'http://127.0.0.1:43188/api/directory/publish',
      SFU_BIND: `127.0.0.1:${50020 + index * 2}`, SFU_PUBLIC_IP: '127.0.0.1', GIMME_DRY_RUN: 'true', DJ_ENABLED: 'false', PUSH_ENABLED: 'false',
    } });
    children.push(child);
    child.on('error', () => { process.stderr.write('Synthetic chat binary could not start.\n'); void stop().then(() => process.exit(1)); });
    let up = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { up = (await fetch(`http://127.0.0.1:${backend}/api/health`)).ok; } catch { /* startup */ }
      if (up) break; await new Promise(r => setTimeout(r, 100));
    }
    if (!up) throw new Error('Synthetic community did not start');
    const call = async (path, body, auth, method = 'POST') => {
      const response = await fetch(`http://127.0.0.1:${backend}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.token}`, 'X-Device-Key': auth.device_key } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
      if (!response.ok) throw new Error('Synthetic seed failed'); return response.json();
    };
    const auth = await call('/setup', { setup_token: 'synthetic-hosted-setup-at-least-32-characters', username: 'fixture_owner', password: 'synthetic community password', device_name: 'synthetic seed' });
    await call('/servers/home', { name: name === 'alpha' ? 'Alpha fixture' : 'Beta fixture' }, auth, 'PATCH');
    const invite = await call('/invites', { expires_in_seconds: 3600 }, auth);
    await call('/invites/accept', { token: invite.token, username: 'fixture_member', password: 'synthetic community password', device_name: 'synthetic seed' });
    const proof = await call('/directory', undefined, auth, 'GET'); proofs.set(proof.dnsName, proof.dnsValue);
    const community = httpsServer(tls, (req, res) => {
      // TLS termination for this community only, never the hosted app origin.
      const outbound = request({ hostname: '127.0.0.1', port: backend, path: req.url, method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      outbound.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outbound);
    });
    await listen(community, port);
  }
  process.stdout.write('Synthetic hosted acceptance fixture ready.\n');
} catch (error) {
  process.stderr.write(`Hosted fixture refused: ${error.code ?? error.message}. No sandbox fallback.\n`);
  await stop(); process.exit(1);
}
