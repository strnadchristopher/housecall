// Actual OPAQUE service and separate synthetic HTTPS server. No user servers.
import * as opaque from '@serenity-kit/opaque';
import { createServer } from 'node:https';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/storage.mjs';
import { createPortal } from '../src/service.mjs';
import { configureHTTP } from '../src/http.mjs';
await opaque.ready;
const directory = mkdtempSync(join(tmpdir(), 'hc-portal-browser-')); chmodSync(directory, 0o700);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const tls = { key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) };
writeFileSync(join(directory, 'accounts.json'), '{"schema":1,"accounts":{}}', { mode: 0o600 });
const store = new Store(directory);
const core = createPortal({ opaque, store, setup: opaque.server.createSetup(), indexKey: randomBytes(32).toString('base64url'), origin: 'https://127.0.0.1:43181', registrationOpen: true });
const portal = createServer(tls, (req, res) => core.emit('request', req, res)); configureHTTP(portal);
const destination = createServer(tls, (req, res) => {
  // Assertion fixture: no central/session data, credential, or referrer may arrive.
  const clean = !req.headers.referer && !req.url.includes('?') && !req.headers.authorization && !req.headers.cookie;
  res.writeHead(clean ? 200 : 400, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' });
  res.end(clean ? '<!doctype html><html lang="en"><title>Synthetic server</title><h1>Server-local login fixture</h1><p>No account credentials are accepted here.</p>' : 'Unexpected referral metadata');
});
for (const server of [portal, destination]) server.on('error', () => { store.close(); process.stderr.write('Browser fixture could not listen.\n'); process.exit(1); });
portal.listen(43181, '127.0.0.1'); destination.listen(43182, '127.0.0.1');
function stop() { portal.close(); destination.close(); core.close(); store.close(); rmSync(directory, { recursive: true }); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
