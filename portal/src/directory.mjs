/** Separate public metadata only. DNS ownership + server signature; never HTTP probes. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, privateFile } from './storage.mjs';
import { decode } from './vault.mjs';
export function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 253) throw new Error('Invalid origin');
  const u = new URL(value);
  // DNS only. Exclude IP literals, special-use names, paths and ambiguous syntax.
  if (u.protocol !== 'https:' || value !== u.origin || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname) || /\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(u.hostname)) throw new Error('Public HTTPS DNS origin required');
  return u;
}
const REPLAY_WINDOW = 300000;
const LISTING_TTL = 7 * 86400000;
const fields = 'description,issued,listed,name,origin';
export function publication(payload, now) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > 2048) throw new Error('Invalid publication');
  const v = JSON.parse(payload);
  if (!v || Object.keys(v).sort().join(',') !== fields || typeof v.listed !== 'boolean' || typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 48 || typeof v.description !== 'string' || v.description.length > 140 || /[\x00-\x1f\x7f]/.test(v.name + v.description) || !Number.isSafeInteger(v.issued) || Math.abs(now - v.issued) > REPLAY_WINDOW) throw new Error('Invalid publication');
  publicOrigin(v.origin); return v;
}
export class Directory {
  constructor({ directory, lookup, now = Date.now } = {}) {
    this.now = now; this.rows = new Map(); this.active = 0;
    this.lookup = lookup ?? (async name => { const resolver = new Resolver({ timeout: 2000, tries: 1 }); return resolver.resolveTxt(name); });
    if (directory) {
      this.path = join(directory, 'directory.json');
      if (existsSync(this.path)) {
        privateFile(this.path); const bytes = readFileSync(this.path);
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Directory too large');
        const rows = JSON.parse(bytes);
        if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid directory');
        for (const row of rows) {
          publicOrigin(row.origin);
          if (typeof row.issued !== 'number' || typeof row.listed !== 'boolean' || typeof row.name !== 'string' || row.name.length > 48 || typeof row.description !== 'string' || row.description.length > 140) throw new Error('Invalid directory');
          this.rows.set(row.origin, row);
        }
      }
    }
  }
  async publish({ payload, publicKey, signature, ...extra }) {
    if (this.broken || Object.keys(extra).length || this.active >= 4) throw new Error('Directory busy or invalid fields');
    this.active++;
    try {
      const value = publication(payload, this.now());
      const der = Buffer.from(decode(publicKey, 44, 44));
      const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(payload), key, Buffer.from(decode(signature, 64, 64)))) throw new Error('Invalid signature');
      const digest = createHash('sha256').update(der).digest('hex');
      const txt = await this.lookup('_housecall-directory.' + new URL(value.origin).hostname);
      if (!txt.some(parts => parts.join('') === 'housecall-directory=' + digest)) throw new Error('DNS ownership not verified');
      // DNS may consume the whole acceptance window. Validate again before commit.
      const now = this.now();
      publication(payload, now);
      // Keep unlist tombstones until every earlier packet is outside the replay window.
      // Pruning and insertion share one bounded atomic persistence operation.
      const next = new Map([...this.rows].filter(([, row]) =>
        now - row.issued <= (row.listed ? LISTING_TTL : REPLAY_WINDOW)));
      // Recheck after asynchronous DNS: concurrent publications cannot move time backwards.
      if (next.get(value.origin)?.issued >= value.issued) throw new Error('Stale publication');
      if (!next.has(value.origin) && next.size >= 1000) throw new Error('Directory full');
      next.set(value.origin, value);
      if (this.path) { try { atomicWrite(this.path, JSON.stringify([...next.values()])); } catch { this.broken = true; throw new Error("Directory storage unavailable"); } }
      this.rows = next;
      return { listed: value.listed };
    } finally { this.active--; }
  }
  search(query, offset) {
    if (typeof query !== 'string' || query.length > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw new Error('Invalid search');
    const q = query.toLocaleLowerCase('en-US');
    const rows = [...this.rows.values()].filter(v => v.listed && this.now() - v.issued < LISTING_TTL && (v.name + ' ' + v.description + ' ' + v.origin).toLocaleLowerCase('en-US').includes(q)).sort((a, b) => a.origin.localeCompare(b.origin));
    return { listings: rows.slice(offset, offset + 20).map(({ origin, name, description }) => ({ origin, name, description })), next: offset + 20 < rows.length ? offset + 20 : null };
  }
}
