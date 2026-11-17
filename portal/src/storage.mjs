import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decode, envelope } from './vault.mjs';
import { dirname, join } from 'node:path';
export const MAX_DB = 100 * 1024 * 1024;
export function privateFile(path) {
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077)) throw new Error('Private file permissions required');
}
export function atomicWrite(path, value) {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
// Linux flock locks the inherited open file description. The Node descriptor
// retains ownership after the utility exits; the kernel releases it on crash.
// Never unlink: every writer must lock the same inode.
export function stateLock(directory) {
  const fd = openSync(join(directory, 'service.lock'), 'a', 0o600);
  try {
    privateFile(join(directory, 'service.lock'));
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    if (result.error || result.status !== 0) throw new Error('State ownership unavailable');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export class Store {
  constructor(directory) {
    const st = statSync(directory);
    if (!st.isDirectory() || (st.mode & 0o077)) throw new Error('Private state directory required');
    this.path = join(directory, 'accounts.json');
    this.fd = stateLock(directory);
    try {
      privateFile(this.path);
      if (statSync(this.path).size > MAX_DB) throw new Error('Database cap exceeded');
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (data.schema !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts) || Object.keys(data.accounts).length > 1000) throw new Error('Invalid database');
      for (const [index, row] of Object.entries(data.accounts)) {
        if (!/^[a-f0-9]{64}$/.test(index) || !row || Object.keys(row).sort().join(',') !== 'binding,envelope,record,revision' || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid row');
        decode(row.binding, 32, 32); decode(row.record, 1, 2048);
        if ((row.revision === 0) !== (row.envelope === null)) throw new Error('Invalid row');
        if (row.envelope !== null) envelope(row.envelope);
      }
      this.accounts = new Map(Object.entries(data.accounts));
    } catch { this.close(); throw new Error('Database unavailable'); }
  }
  commit(next) {
    if (next.size > 1000) throw new Error('Account cap exceeded');
    const value = JSON.stringify({ schema: 1, accounts: Object.fromEntries(next) });
    if (Buffer.byteLength(value) > MAX_DB) throw new Error('Database cap exceeded');
    try { atomicWrite(this.path, value); this.accounts = next; }
    catch { this.broken = true; throw new Error('Persistence unavailable'); }
  }
  set(index, row) { const next = new Map(this.accounts); next.set(index, row); this.commit(next); }
  delete(index) { const next = new Map(this.accounts); next.delete(index); this.commit(next); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}
