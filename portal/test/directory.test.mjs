import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { Directory, publicOrigin } from '../src/directory.mjs';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ type: 'spki', format: 'der' });
const proof = 'housecall-directory=' + createHash('sha256').update(der).digest('hex');
const now = 1800000000000;
function packet(overrides = {}, key = privateKey) {
  const payload = JSON.stringify({ origin: 'https://chat.fixture.org', name: 'Synthetic club', description: 'Local fixture', listed: true, issued: now, ...overrides });
  return { payload, publicKey: der.toString('base64url'), signature: sign(null, Buffer.from(payload), key).toString('base64url') };
}
test('DNS verified signed publication, search without probes, replay, update and unlist', async () => {
  let lookups = 0;
  const directory = new Directory({ now: () => now, lookup: async name => { assert.equal(name, '_housecall-directory.chat.fixture.org'); lookups++; return [[proof]]; } });
  await directory.publish(packet());
  assert.equal(directory.search('club', 0).listings.length, 1);
  assert.equal(directory.search('absent', 0).listings.length, 0);
  assert.equal(lookups, 1);
  await assert.rejects(directory.publish(packet()), /Stale/);
  await directory.publish(packet({ issued: now + 1, description: 'Changed' }));
  assert.equal(directory.search('changed', 0).listings.length, 1);
  await directory.publish(packet({ issued: now + 2, listed: false }));
  assert.deepEqual(directory.search('', 0), { listings: [], next: null });
});
test('unverified ownership, signature, stale time and unsafe origins are refused', async () => {
  const directory = new Directory({ now: () => now, lookup: async () => [['wrong']] });
  await assert.rejects(directory.publish(packet()), /DNS/);
  const other = generateKeyPairSync('ed25519');
  await assert.rejects(directory.publish(packet({}, other.privateKey)), /signature/);
  await assert.rejects(directory.publish(packet({ issued: now - 300001 })), /Invalid/);
  for (const value of ['http://chat.fixture.org', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://chat.local', 'https://chat.fixture.org:443', 'https://chat.fixture.org/path', 'https://u:p@chat.fixture.org']) assert.throws(() => publicOrigin(value));
});
test('pagination, expiry, DNS rotation recovery and signed deletion', async () => {
  let clock = now, txt = proof;
  const directory = new Directory({ now: () => clock, lookup: async () => [[txt]] });
  for (let i = 0; i < 25; i++) await directory.publish(packet({ origin: `https://node${i}.fixture.org` }));
  assert.equal(directory.search('', 0).listings.length, 20);
  assert.equal(directory.search('', 0).next, 20);
  assert.equal(directory.search('', 20).listings.length, 5);
  clock += 7 * 86400000 + 1;
  assert.equal(directory.search('', 0).listings.length, 0);
  const rotated = generateKeyPairSync('ed25519'), nextDer = rotated.publicKey.export({ type: 'spki', format: 'der' });
  txt = 'housecall-directory=' + createHash('sha256').update(nextDer).digest('hex');
  const payload = JSON.stringify({ origin: 'https://node0.fixture.org', name: 'Recovered', description: '', listed: false, issued: clock });
  await directory.publish({ payload, publicKey: nextDer.toString('base64url'), signature: sign(null, Buffer.from(payload), rotated.privateKey).toString('base64url') });
  assert.equal(directory.search('', 0).listings.length, 0);
});

test('capacity reclaims expired listings and aged tombstones, persists across reopen, retains replay protection', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = mkdtempSync(join(tmpdir(), 'housecall-directory-cap-'));
  let clock = now;
  const options = { directory: path, now: () => clock, lookup: async () => [[proof]] };
  const row = (origin, issued, listed = true) => JSON.parse(packet({ origin, issued, listed }).payload);
  try {
    const rows = Array.from({ length: 998 }, (_, i) => row(`https://node${i}.fixture.org`, now));
    rows.push(row('https://expired.fixture.org', now - 7 * 86400000 - 1));
    rows.push(row('https://unlisted.fixture.org', now, false));
    writeFileSync(join(path, 'directory.json'), JSON.stringify(rows), { mode: 0o600 });
    let directory = new Directory(options);
    await directory.publish(packet({ origin: 'https://replacement.fixture.org' }));
    assert.equal(directory.rows.size, 1000);
    assert.equal(directory.rows.has('https://expired.fixture.org'), false);
    directory = new Directory(options);
    clock = now + 300000;
    // At the last accepted millisecond an earlier signed listing cannot undo unlist.
    await assert.rejects(directory.publish(packet({ origin: 'https://unlisted.fixture.org' })), /Stale/);
    await assert.rejects(directory.publish(packet({ origin: 'https://overflow.fixture.org', issued: clock })), /full/);
    clock++;
    await assert.rejects(directory.publish(packet({ origin: 'https://unlisted.fixture.org' })), /Invalid/);
    await directory.publish(packet({ origin: 'https://overflow.fixture.org', issued: clock }));
    assert.equal(directory.rows.size, 1000);
    assert.equal(directory.rows.has('https://unlisted.fixture.org'), false);
    assert.equal(JSON.parse(readFileSync(join(path, 'directory.json'))).length, 1000);
    directory = new Directory(options);
    assert.equal(directory.rows.has('https://overflow.fixture.org'), true);
    clock = now + 7 * 86400000 + 1;
    await directory.publish(packet({ issued: clock }));
    assert.equal(new Directory(options).rows.size, 2);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('a DNS await cannot admit a packet after its replay window expires', async () => {
  let clock = now;
  const directory = new Directory({ now: () => clock, lookup: async () => { clock += 300001; return [[proof]]; } });
  await assert.rejects(directory.publish(packet()), /Invalid/);
  assert.equal(directory.rows.size, 0);
});
