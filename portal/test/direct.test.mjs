import test from 'node:test';
import assert from 'node:assert/strict';
import { serverAddress, serverList } from '../src/direct.mjs';
import { Limits, peerIP } from '../src/limits.mjs';
test('HTTPS destination parsing rejects unsafe and misleading URL forms without networking', () => {
  assert.equal(serverAddress('https://community.example/front/'), 'https://community.example/front/');
  assert.equal(serverAddress('http://127.0.0.1:44555/'), 'http://127.0.0.1:44555/');
  assert.equal(serverAddress('https://localhost:44555/'), 'https://localhost:44555/');
  for (const input of ['javascript:alert(1)', 'data:text/html,hello', '//community.example', 'http://community.example', 'https://u:p@community.example', 'https://@community.example', 'https://community.example?', 'https://community.example#', 'https://community.example/?secret=x', 'https://community.example/\n', 'https:\\community.example', 'https://community.example /', 'http://127.1/', 'http://2130706433/']) {
    assert.throws(() => serverAddress(input), undefined, input);
  }
  assert.throws(() => serverList({ format: 1, servers: ['https://community.example/', 'https://community.example/'] }));
  assert.throws(() => serverList({ format: 1, servers: [], password: 'forbidden' }));
});
test('rate maps rotate and limits have a global cap; forwarding spoof is ignored', () => {
  let time = 0; const limits = new Limits(() => time);
  for (let i = 0; i < 30; i++) assert.equal(limits.allow('a'), true);
  assert.equal(limits.allow('a'), false); const salt = limits.salt;
  time = 60001; assert.equal(limits.allow('a'), true); assert.notDeepEqual(limits.salt, salt);
  for (let i = 0; i < 299; i++) assert.equal(limits.allow(String(i)), true);
  assert.equal(limits.allow('next'), false);
  const req = { socket: { remoteAddress: '192.0.2.10' }, headers: { 'x-forwarded-for': 'spoof' } };
  assert.equal(peerIP(req, false), '192.0.2.10'); assert.throws(() => peerIP(req, true));
  req.socket.remoteAddress = '127.0.0.1'; assert.throws(() => peerIP(req, true));
});
