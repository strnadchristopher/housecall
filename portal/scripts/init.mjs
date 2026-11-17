import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { closeSync } from 'node:fs';
import { stateLock } from '../src/storage.mjs';
import { randomBytes } from 'node:crypto';
const directory = process.env.PORTAL_STATE;
const secrets = process.env.PORTAL_SECRETS_FILE;
if (!directory || !secrets || !isAbsolute(secrets) || !isAbsolute(directory)) throw new Error('Set private absolute PORTAL_STATE and PORTAL_SECRETS_FILE');
if (existsSync(secrets) || existsSync(join(directory, 'accounts.json'))) throw new Error('Refusing to overwrite existing state');
const opaque = await import('@serenity-kit/opaque'); await opaque.ready;
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (statSync(directory).mode & 0o077) throw new Error('State directory must be private');
const lock = stateLock(directory);
try {
  if (existsSync(secrets) || existsSync(join(directory, 'accounts.json'))) throw new Error('Refusing to overwrite existing state');
  // Secret values go only to private files, never stdout or command arguments.
  writeFileSync(secrets, JSON.stringify({ setup: opaque.server.createSetup(), indexKey: randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'accounts.json'), JSON.stringify({ schema: 1, accounts: {} }), { flag: 'wx', mode: 0o600 });
  console.log('Private setup created. Preserve it with the database.');
} finally { closeSync(lock); }
