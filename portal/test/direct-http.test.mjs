import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
test('actual dependency-free static service keeps direct path available while API returns 503', { timeout: 15000 }, async () => {
  const child = fork(new URL('../src/direct-main.mjs', import.meta.url), { env: { ...process.env, PORTAL_PORT: '0' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const ready = await Promise.race([once(child, 'message').then(([v]) => v), once(child, 'exit').then(() => { throw new Error('Actual loopback service could not start; run outside sandbox'); })]);
    const base = 'http://127.0.0.1:' + ready.port;
    const page = await fetch(base + '/app/'); assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text(); assert.ok(html.includes('Connect directly to a server')); assert.ok(html.includes('href="/"'));
    assert.equal((await fetch(base + '/app/direct.mjs')).status, 200);
    const api = await fetch(base + '/api/account/status'); assert.equal(api.status, 503);
    assert.match((await api.json()).error, /unavailable/);
    assert.equal((await fetch(base + '/app/')).status, 200);
    assert.equal((await fetch(base + '/app/styles.css')).status, 200);
    assert.equal((await fetch(base + '/app/%2e%2e/secrets.json')).status, 404);
  } finally { child.kill('SIGTERM'); }
});
