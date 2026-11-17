import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, webcrypto } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import { vaultKey, seal, open, encode } from '../src/vault.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
await opaque.ready;
const origin = 'https://portal.example';
const password = () => randomBytes(32).toString('base64url');
test('REAL OPAQUE HTTP roundtrip, adversarial boundaries and full-process persistence', { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-portal-real-')); chmodSync(directory, 0o700);
  const secrets = join(directory, 'secrets.json'), db = join(directory, 'accounts.json');
  writeFileSync(secrets, JSON.stringify({ setup: opaque.server.createSetup(), indexKey: randomBytes(32).toString('base64url') }), { mode: 0o600 });
  writeFileSync(db, '{"schema":1,"accounts":{}}', { mode: 0o600 });
  let child, base;
  async function boot() {
    child = fork(new URL('./service-child.mjs', import.meta.url), { env: { ...process.env, PORTAL_STATE: directory, PORTAL_SECRETS_FILE: secrets }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Actual service exited before listening; inspect listener/state gate'); })]); assert.ok(ready.port, ready.error || 'Actual service must start'); base = 'http://127.0.0.1:' + ready.port;
  }
  async function stop() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = null; }
  async function advance(ms = 61000) { const response = once(child, 'message'); child.send({ advance: ms }); await response; }
  async function call(path, value, { cookie, method = value === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(base + '/api/account' + path, { method, headers: { Origin: origin, 'X-HouseCall': '1', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], rawCookie: response.headers.get('set-cookie') };
  }
  async function register(name, pw) {
    const start = opaque.client.startRegistration({ password: pw });
    const response = await call('/register/start', { username: name, registrationRequest: start.registrationRequest }); assert.equal(response.status, 200);
    const finish = opaque.client.finishRegistration({ password: pw, clientRegistrationState: start.clientRegistrationState, registrationResponse: response.value.registrationResponse, identifiers: { client: name, server: origin }, keyStretching: 'memory-constrained' });
    const upload = { exchange: response.value.exchange, registrationRecord: finish.registrationRecord };
    assert.equal((await call('/register/finish', upload)).status, 201);
    assert.equal((await call('/register/finish', upload)).status, 401, 'registration exchange replay');
    return finish.exportKey;
  }
  async function login(name, pw) {
    const start = opaque.client.startLogin({ password: pw });
    const response = await call('/login/start', { username: name, startLoginRequest: start.startLoginRequest }); assert.equal(response.status, 200);
    const finish = opaque.client.finishLogin({ password: pw, clientLoginState: start.clientLoginState, loginResponse: response.value.loginResponse, identifiers: { client: name, server: origin }, keyStretching: 'memory-constrained' });
    if (!finish) return null;
    const request = { exchange: response.value.exchange, finishLoginRequest: finish.finishLoginRequest };
    const authenticated = await call('/login/finish', request); assert.equal(authenticated.status, 200);
    assert.ok(/Secure; HttpOnly; SameSite=Strict/.test(authenticated.rawCookie), 'Cookie security attributes');
    return { ...authenticated, exported: finish.exportKey, request };
  }
  try {
    await boot(); const pw = password(), pw2 = password();
    const exported = await register('roundtrip_one', pw);
    assert.ok((await login('roundtrip_one', password())) === null, 'wrong password must fail client proof');
    assert.ok((await login('unknown_account', pw)) === null, 'unknown account uses a fake OPAQUE response');
    const first = await login('roundtrip_one', pw); assert.ok(first.exported === exported, 'exportKey must be stable');
    assert.equal((await call('/login/finish', first.request)).status, 401, 'login proof replay');
    const key = await vaultKey(first.exported, first.value.binding);
    const list = { format: 1, servers: ['https://vault-plaintext-marker.example/'] };
    const ciphertext = await seal(key, first.value.binding, 1, list);
    assert.equal((await call('/vault', { expectedBinding: first.value.binding, expectedRevision: 0, envelope: ciphertext }, { cookie: first.cookie, method: 'PUT' })).status, 200);
    const read = await call('/vault', undefined, { cookie: first.cookie });
    assert.deepEqual(await open(key, read.value.binding, read.value.revision, read.value.envelope), list);
    const disk = readFileSync(db, 'utf8');
    for (const marker of ['vault-plaintext-marker', 'roundtrip_one', pw, first.exported, first.cookie.split('=')[1]]) assert.ok(!disk.includes(marker), 'no plaintext/secret marker on disk');
    const stale = await call('/vault', { expectedBinding: first.value.binding, expectedRevision: 0, envelope: ciphertext }, { cookie: first.cookie, method: 'PUT' });
    assert.equal(stale.status, 409, 'stale CAS'); assert.equal(stale.value.code, undefined, 'CAS is not account change');
    assert.equal((await call('/vault', undefined)).status, 401);
    assert.equal((await call('/vault', undefined, { cookie: first.cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/vault', undefined, { cookie: first.cookie, headers: { 'X-HouseCall': '' } })).status, 403);
    const savedBeforeDuplicate = readFileSync(db, 'utf8');
    const dup = opaque.client.startRegistration({ password: password() });
    const duplicate = await call('/register/start', { username: 'ROundtrip_one', registrationRequest: dup.registrationRequest });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.value.code, undefined, 'duplicate name is not account change');
    assert.equal(readFileSync(db, 'utf8'), savedBeforeDuplicate);
    await advance();
    await register('roundtrip_two', pw2); const second = await login('roundtrip_two', pw2);
    const secondVault = await call('/vault', undefined, { cookie: second.cookie }); assert.equal(secondVault.value.envelope, null);
    assert.notEqual(second.value.binding, first.value.binding);
    assert.equal((await call('/vault', { expectedBinding: second.value.binding, expectedRevision: 0, envelope: ciphertext, account: first.value.binding }, { cookie: second.cookie, method: 'PUT' })).status, 400);
    await assert.rejects(open(await vaultKey(second.exported, second.value.binding), second.value.binding, 1, ciphertext));
    // Cookie authenticates B; initiating tab still holds A. Reject before CAS or any mutation.
    const beforeBindingChecks = readFileSync(db, 'utf8');
    const pendingB = opaque.client.startLogin({ password: pw2 });
    const pendingBResponse = await call('/login/start', { username: 'roundtrip_two', startLoginRequest: pendingB.startLoginRequest });
    assert.equal(pendingBResponse.status, 200);
    for (const expectedBinding of [undefined, null, 'bad', 'A'.repeat(42), 'A'.repeat(42) + 'B']) {
      const binding = expectedBinding === undefined ? {} : { expectedBinding };
      assert.equal((await call('/vault', { ...binding, expectedRevision: 0, envelope: ciphertext }, { cookie: second.cookie, method: 'PUT' })).status, 400, 'missing/malformed PUT binding');
      assert.equal((await call('/', { ...binding, confirmation: 'DELETE' }, { cookie: second.cookie, method: 'DELETE' })).status, 400, 'missing/malformed DELETE binding');
    }
    for (const [path, value, method] of [
      ['/vault', { expectedBinding: first.value.binding, expectedRevision: 0, envelope: ciphertext }, 'PUT'],
      ['/', { expectedBinding: first.value.binding, confirmation: 'DELETE' }, 'DELETE'],
    ]) {
      const rejected = await call(path, value, { cookie: second.cookie, method });
      assert.equal(rejected.status, 409, 'wrong tab binding rejected even at equal revision');
      assert.equal(rejected.value.code, 'account_changed');
      assert.equal(rejected.rawCookie, null, 'mismatch must not change shared cookie');
    }
    assert.equal((await call('/', { expectedBinding: second.value.binding, confirmation: 'DELETE', account: first.value.binding }, { cookie: second.cookie, method: 'DELETE' })).status, 400, 'DELETE unknown field');
    assert.equal(readFileSync(db, 'utf8'), beforeBindingChecks, 'binding failures preserve exact database bytes');
    assert.deepEqual((await call('/vault', undefined, { cookie: second.cookie })).value, secondVault.value, 'B session and vault survive');
    const finishB = opaque.client.finishLogin({ password: pw2, clientLoginState: pendingB.clientLoginState, loginResponse: pendingBResponse.value.loginResponse, identifiers: { client: 'roundtrip_two', server: origin }, keyStretching: 'memory-constrained' });
    assert.equal((await call('/login/finish', { exchange: pendingBResponse.value.exchange, finishLoginRequest: finishB.finishLoginRequest })).status, 200, 'B pending exchange survives rejected deletion');
    await advance();

    assert.equal((await call('/logout', {}, { cookie: first.cookie })).status, 200);
    assert.equal((await call('/vault', undefined, { cookie: first.cookie })).status, 401, 'logout invalidates');
    const malformedStart = await call('/login/start', { username: 'roundtrip_one', startLoginRequest: 'AAAA' }); assert.equal(malformedStart.status, 400);
    const pendingStart = opaque.client.startLogin({ password: pw });
    const pending = await call('/login/start', { username: 'roundtrip_one', startLoginRequest: pendingStart.startLoginRequest });
    assert.equal((await call('/login/finish', { exchange: pending.value.exchange, finishLoginRequest: encode(new Uint8Array(64)) })).status, 401);
    assert.equal((await call('/login/finish', { exchange: pending.value.exchange, finishLoginRequest: encode(new Uint8Array(64)) })).status, 401);
    const expiring = await call('/login/start', { username: 'roundtrip_one', startLoginRequest: pendingStart.startLoginRequest });
    await advance();
    assert.equal((await call('/login/finish', { exchange: expiring.value.exchange, finishLoginRequest: encode(new Uint8Array(64)) })).status, 401, 'expired exchange');
    assert.equal((await call('/login/start', { username: 'roundtrip_one', startLoginRequest: pendingStart.startLoginRequest, extra: true })).status, 400, 'unknown fields');
    assert.equal((await call('/login/start', { username: 'x'.repeat(33000), startLoginRequest: pendingStart.startLoginRequest })).status, 413, 'payload cap');
    const invalidBox = { ...ciphertext, iv: 'AAAA' };
    assert.equal((await call('/vault', { expectedBinding: second.value.binding, expectedRevision: 1, envelope: invalidBox }, { cookie: second.cookie, method: 'PUT' })).status, 400, 'malformed AEAD envelope');
    await advance();
    for (let n = 0; n < 30; n++) assert.equal((await call('/status')).status, 200);
    assert.equal((await call('/status')).status, 429, 'actual HTTP rate limit');
    await advance();
    const oldCookie = second.cookie;
    const contender = fork(new URL('./service-child.mjs', import.meta.url), { env: { ...process.env, PORTAL_STATE: directory, PORTAL_SECRETS_FILE: secrets }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const [exitCode] = await once(contender, 'exit'); assert.notEqual(exitCode, 0, 'second actual service cannot acquire live ownership');
    const crashed = once(child, 'exit'); child.kill('SIGKILL'); await crashed; child = null;
    await boot();
    assert.equal((await call('/vault', undefined, { cookie: oldCookie })).status, 401, 'restart invalidates RAM sessions');
    const restored = await login('roundtrip_one', pw); assert.ok(restored.exported === exported, 'setup/record persist');
    const persisted = await call('/vault', undefined, { cookie: restored.cookie });
    assert.deepEqual(await open(await vaultKey(restored.exported, restored.value.binding), persisted.value.binding, persisted.value.revision, persisted.value.envelope), list);
    await advance(300001);
    assert.equal((await call('/', { expectedBinding: restored.value.binding, confirmation: 'DELETE' }, { cookie: restored.cookie, method: 'DELETE' })).status, 403, 'deletion requires recent authentication');
    const recent = await login('roundtrip_one', pw);
    assert.equal((await call('/', { expectedBinding: recent.value.binding, confirmation: 'no' }, { cookie: recent.cookie, method: 'DELETE' })).status, 403);
    assert.equal((await call('/', { expectedBinding: recent.value.binding, confirmation: 'DELETE' }, { cookie: recent.cookie, method: 'DELETE' })).status, 200);
    assert.equal((await call('/vault', undefined, { cookie: recent.cookie })).status, 401);
    assert.equal(JSON.parse(readFileSync(db, 'utf8')).accounts && Object.keys(JSON.parse(readFileSync(db, 'utf8')).accounts).length, 1, 'other account survives deletion');
    const expiringSession = await login('roundtrip_two', pw2);
    assert.equal((await call('/vault', undefined, { cookie: expiringSession.cookie })).status, 200, 'surviving account has valid fresh session after restart');
    await advance(1800001);
    assert.equal((await call('/vault', undefined, { cookie: expiringSession.cookie })).status, 401, 'fresh session expires past absolute TTL');
  } finally { if (child) await stop(); rmSync(directory, { recursive: true }); }
});
