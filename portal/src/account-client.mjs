import { vaultKey, seal, open } from './vault.mjs';
import { deviceVault } from './device-vault.mjs';
const accountChanged = () => Object.assign(new Error('Account changed in another tab. Log in again.'), { status: 409, code: 'account_changed' });
export async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/account' + path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-HouseCall': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal });
    let value; try { value = await response.json(); } catch { throw new Error('Account service unavailable. Retry later.'); }
    if (!response.ok) {
      if (response.status === 409 && value.code === 'account_changed') throw accountChanged();
      const conflict = path === '/vault' ? 'Saved list changed. Reload the saved list before editing, then retry.' : 'Username unavailable. Choose another username.';
      const known = { 401: 'Incorrect login or expired session. Log in again.', 403: 'Request refused. For deletion, log in again first.', 409: conflict, 429: 'Too many requests. Retry in a minute.', 503: 'Account service unavailable or registration closed. Retry later. Direct connection is available.' };
      throw Object.assign(new Error(known[response.status] || 'Account request rejected. Check your inputs and retry.'), { status: response.status });
    }
    return value;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('Account service unavailable. Retry later. Direct connection is available.');
    throw error;
  } finally { clearTimeout(timer); }
}
export class Account {
  name = null;
  key = null; binding = null; revision = 0; list = null;
  clear() { this.name = null; this.key = null; this.binding = null; this.revision = 0; this.list = null; }
  async authenticate(name, password, register = false) {
    this.clear();
    name = name.normalize('NFKC').toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(name) || password.length < 12 || password.length > 256) throw new Error('Use a username of 3–32 letters, numbers or underscores and a password of 12–256 characters.');
    let opaque;
    try { opaque = await import('./opaque.mjs'); await opaque.ready; } catch { throw new Error('Account encryption is unavailable. Retry later. Direct connection is available.'); }
    const identifiers = { client: name, server: location.origin };
    if (register) {
      const start = opaque.client.startRegistration({ password });
      const reply = await api('/register/start', { username: name, registrationRequest: start.registrationRequest });
      const finish = opaque.client.finishRegistration({ password, clientRegistrationState: start.clientRegistrationState, registrationResponse: reply.registrationResponse, identifiers, keyStretching: 'memory-constrained' });
      await api('/register/finish', { exchange: reply.exchange, registrationRecord: finish.registrationRecord });
      // Registration does not grant a session. Prove the new record via real login.
    }
    const start = opaque.client.startLogin({ password });
    const reply = await api('/login/start', { username: name, startLoginRequest: start.startLoginRequest });
    let finish;
    try { finish = opaque.client.finishLogin({ password, clientLoginState: start.clientLoginState, loginResponse: reply.loginResponse, identifiers, keyStretching: 'memory-constrained' }); }
    catch { throw new Error('Incorrect username or password.'); }
    if (!finish) throw new Error('Incorrect username or password.');
    const result = await api('/login/finish', { exchange: reply.exchange, finishLoginRequest: finish.finishLoginRequest });
    try {
      this.key = await vaultKey(finish.exportKey, result.binding); this.binding = result.binding;
      finish = null; await this.load(); this.name = name;
    } catch (error) { this.clear(); if (error.code === 'account_changed') throw error; throw new Error('Could not open your encrypted list. Nothing was overwritten. Retry login or use direct connection.'); }
  }
  // Persistence is explicitly requested by the hosted client; the old portal stays memory-only.
  async remember() {
    if (!this.key || !this.binding) throw new Error('Log in again.');
    await deviceVault({ key: this.key, binding: this.binding, name: this.name });
  }
  async restore() {
    const stored = await deviceVault();
    if (!stored) return false;
    try {
      if (stored.key?.extractable !== false || stored.key?.algorithm?.name !== 'AES-GCM') throw new Error('Invalid device key.');
      this.key = stored.key; this.binding = stored.binding; this.name = stored.name;
      await this.load(); return true;
    } catch (error) {
      this.clear();
      // A transient outage must not destroy an otherwise valid device key.
      if (error.status === 401 || error.code === 'account_changed') await deviceVault(null, stored.binding);
      throw error;
    }
  }
  async forgetDevice(binding = this.binding) { this.clear(); await deviceVault(null, binding).catch(() => {}); }
  async load() {
    if (!this.key) throw new Error('Log in to unlock your saved list.');
    const result = await api('/vault');
    if (result.binding !== this.binding) throw accountChanged();
    if (!Number.isSafeInteger(result.revision) || result.revision < this.revision || (result.revision === 0) !== (result.envelope === null)) throw new Error('Saved list binding or revision rejected.');
    const list = result.envelope ? await open(this.key, this.binding, result.revision, result.envelope) : { format: 1, servers: [] };
    this.list = list; this.revision = result.revision; return list;
  }
  async save(list) {
    if (!this.key || !this.list) throw new Error('Log in to unlock your saved list.');
    const value = await seal(this.key, this.binding, this.revision + 1, list);
    const result = await api('/vault', { expectedBinding: this.binding, expectedRevision: this.revision, envelope: value }, 'PUT');
    if (result.revision !== this.revision + 1) throw new Error('Unexpected saved revision. Reload the saved list.');
    this.revision = result.revision; this.list = list;
  }
  async logout() { try { await api('/logout', {}); } finally { await this.forgetDevice(); } }
  async delete() { await api('/', { expectedBinding: this.binding, confirmation: 'DELETE' }, 'DELETE'); await this.forgetDevice(); }
}
