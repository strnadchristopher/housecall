import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
test('private atomic store persists across reopen and refuses a second writer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hc-portal-storage-')); chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'accounts.json'), '{"schema":1,"accounts":{}}', { mode: 0o600 });
  try {
    const store = new Store(directory);
    assert.throws(() => new Store(directory));
    store.set('a'.repeat(64), { binding: 'A'.repeat(43), record: 'AAAA', revision: 0, envelope: null }); store.close();
    const reopened = new Store(directory); assert.equal(reopened.accounts.size, 1); reopened.delete('a'.repeat(64)); reopened.close();
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'accounts.json'), 'utf8')).accounts, {});
  } finally { rmSync(directory, { recursive: true }); }
});

test('OS ownership rejects a live writer and releases after SIGKILL with encrypted state intact', async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { randomBytes, webcrypto } = await import('node:crypto');
  const { vaultKey, seal, open } = await import('../src/vault.mjs');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const directory = mkdtempSync(join(tmpdir(), 'hc-portal-crash-')); chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'accounts.json'), '{"schema":1,"accounts":{}}', { mode: 0o600 });
  let child;
  const boot = async () => {
    child = fork(new URL('./storage-child.mjs', import.meta.url), { env: { ...process.env, PORTAL_STATE: directory }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await once(child, 'message'); assert.equal(message.ready, true);
  };
  try {
    await boot(); assert.throws(() => new Store(directory), /ownership/);
    const binding = randomBytes(32).toString('base64url');
    const key = await vaultKey(randomBytes(32).toString('base64url'), binding);
    const list = { format: 1, servers: ['https://crash-fixture.example/'] };
    const row = { binding, record: 'AAAA', revision: 1, envelope: await seal(key, binding, 1, list) };
    const index = 'b'.repeat(64);
    const committed = once(child, 'message'); child.send({ index, row }); await committed;
    assert.ok(!readFileSync(join(directory, 'accounts.json'), 'utf8').includes('crash-fixture'));
    const killed = once(child, 'exit'); child.kill('SIGKILL'); await killed; child = null;
    await boot();
    const loaded = once(child, 'message'); child.send({ read: true });
    const [state] = await loaded; assert.deepEqual(state.accounts[index], row);
    assert.deepEqual(await open(key, binding, 1, state.accounts[index].envelope), list);
    assert.throws(() => new Store(directory), /ownership/);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    rmSync(directory, { recursive: true });
  }
});
