import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = new URL('../node_modules/@serenity-kit/opaque/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));
assert.equal(pkg.version, '1.1.0'); assert.equal(pkg.license, 'MIT');
assert.ok(existsSync(new URL('../package-lock.json', import.meta.url)), 'Generate and review the npm lockfile first');
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const installed = lock.packages['node_modules/@serenity-kit/opaque'];
assert.equal(installed.version, '1.1.0');
assert.equal(installed.integrity, 'sha512-Y6v/+hRMn0MdMEk5+/ArM0vPIiFfFEbdTZc7oAx+cWyvGODGezAQ/sMjXBVogf7NsS9z9EV0Ve5paZCVULuedw==');
const types = readFileSync(new URL('index.d.ts', base), 'utf8');
for (const name of ['exportKey', 'registrationRecord', 'startLogin', 'finishLogin', 'serverLoginState', 'memory-constrained']) assert.ok(types.includes(name), `Missing API ${name}`);
const opaque = await import('@serenity-kit/opaque'); await opaque.ready;
for (const [side, methods] of Object.entries({ client: ['startRegistration', 'finishRegistration', 'startLogin', 'finishLogin'], server: ['createSetup', 'getPublicKey', 'createRegistrationResponse', 'startLogin', 'finishLogin'] })) for (const method of methods) assert.equal(typeof opaque[side][method], 'function');
for (const file of ['package.json', 'index.d.ts', 'esm/index.js', 'cjs/index.js', 'README.md', 'LICENSE']) console.log(file + ' sha256 ' + createHash('sha256').update(readFileSync(new URL(file, base))).digest('hex'));
console.log('API shape/version/license metadata verified. Human artifact/license/provenance/advisory review still required.');
// Real installed crypto, no sockets, passwords/keys never printed or persisted.
const { randomBytes } = await import('node:crypto');
const password = randomBytes(32).toString('base64url');
const serverSetup = opaque.server.createSetup(), userIdentifier = 'dependency-fixture';
const identifiers = { client: userIdentifier, server: 'https://portal.example' };
const registration = opaque.client.startRegistration({ password });
const response = opaque.server.createRegistrationResponse({ serverSetup, userIdentifier, registrationRequest: registration.registrationRequest });
const record = opaque.client.finishRegistration({ password, clientRegistrationState: registration.clientRegistrationState, registrationResponse: response.registrationResponse, identifiers, keyStretching: 'memory-constrained' });
for (const candidate of [password, password, randomBytes(32).toString('base64url')]) {
  const start = opaque.client.startLogin({ password: candidate });
  const reply = opaque.server.startLogin({ serverSetup, userIdentifier, registrationRecord: record.registrationRecord, startLoginRequest: start.startLoginRequest, identifiers });
  const finish = opaque.client.finishLogin({ password: candidate, clientLoginState: start.clientLoginState, loginResponse: reply.loginResponse, identifiers, keyStretching: 'memory-constrained' });
  if (candidate !== password) { assert.ok(finish === undefined, 'Wrong password must fail without emitting secrets'); continue; }
  assert.ok(finish); assert.ok(finish.exportKey === record.exportKey, 'Stable exportKey');
  assert.ok(opaque.server.finishLogin({ serverLoginState: reply.serverLoginState, finishLoginRequest: finish.finishLoginRequest, identifiers }).sessionKey === finish.sessionKey, 'Matching session keys');
}
console.log('Real registration/two logins/stable exportKey/wrong password PASS (memory-constrained). This is not HTTP/browser acceptance.');
