import { conversationKey, inlineMimeAllowed, openAttachment, openMessage, parseEnvelope, safeDownloadName, sealFile, sealMessage, validateFileRef, type FileRef, type Payload } from '../../crypto/dm';
import { b64u, deriveIdentity, destroyIdentity, publicIdentityKey, unb64u } from '../../crypto/identity';
import { randomBytes, unwrap } from '../../crypto/common';
import { safetyNumber } from '../../crypto/safetyNumber';
import type { Pin } from '../../crypto/link';
import { withIdentityLock } from '../../core/identityLock';
import { acknowledgePeer, evaluatePeer } from '../../core/pins';
import { plaintextMessage, replyStatus, type DmContext, type OpenedDmMessage, type SecureMessageRow } from '../../core/dm';
import type { PeerSecurity, SecurityVault } from '../../core/security';
import { ApiError } from '../../transport/api';
import type { Api } from '../../transport/api';
import type { Upload } from '../../transport/uploads';
import { SecurityApi } from './security';

/** Dedicated opt-in adapter for the next UI phase. Does not activate identity setup or alter group/channel transport. */
export class DmService {
  private peers = new Map<string, PeerSecurity>();
  private fetched = new Map<string, number>();
  private envelopeFetches = new Set<string>();
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly remote: SecurityApi;
  constructor(readonly api: Api, readonly vault: SecurityVault, readonly origin: string, readonly myId: string) { this.remote = new SecurityApi(api); }
  private active() { if (this.generation) throw new Error('Security session ended'); }
  private peer(context: DmContext): string {
    this.active();
    if (context.kind !== 'dm' || context.memberIds.length !== 2 || new Set(context.memberIds).size !== 2 || !context.memberIds.includes(this.myId)) throw new Error('Encrypted conversation must have exactly two members');
    return context.memberIds.find(id => id !== this.myId)!;
  }
  private async pins() { return this.vault.loadPins(this.origin, this.myId); }
  private async pin(user: string) { return (await this.pins()).find(p => p.user_id === user); }
  private save(pin: Pin, expected?: Pin) {
    const pending = this.queue.then(() => withIdentityLock(this.vault, async () => {
      this.active(); const pins = await this.pins(), current = pins.find(p => p.user_id === pin.user_id); this.active();
      if (expected && JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Pinned key changed during confirmation');
      // Another DM service may have completed TOFU while this request was in flight.
      if (!expected && current) return;
      await this.vault.savePins(this.origin, this.myId, [...pins.filter(p => p.user_id !== pin.user_id), pin]);
    }));
    this.queue = pending.catch(() => {}); return pending;
  }
  async refresh(user: string, force = false): Promise<PeerSecurity> {
    this.active();
    if (!force && this.peers.has(user) && Date.now() - (this.fetched.get(user) ?? 0) < 60_000) {
      const stored = await this.pin(user), cached = this.peers.get(user); this.active();
      if (cached && JSON.stringify(stored) === JSON.stringify(cached.pin)) return cached;
    }
    const generation = this.generation, response = await this.remote.keys(user), pin = await this.pin(user);
    if (generation !== this.generation) throw new Error('Security session ended');
    let state = evaluatePeer(pin, response, this.origin, user);
    if (!pin && state.pin) { await this.save(state.pin); state = evaluatePeer(await this.pin(user), response, this.origin, user); }
    this.active(); this.peers.set(user, state); this.fetched.set(user, Date.now()); return state;
  }
  async acknowledgeChange(user: string) {
    const pin = await this.pin(user); if (!pin) throw new Error('No pinned key');
    const response = await this.remote.keys(user), state = evaluatePeer(pin, response, this.origin, user);
    this.peers.set(user, state);
    if (!state.canAcknowledge) throw new Error('Key change cannot be acknowledged');
    // Key removal never enables plaintext, even after acknowledgement.
    if (!response.identity_key) return state;
    await this.save(acknowledgePeer(pin, response), pin); return this.refresh(user, true);
  }
  async safety(user: string) {
    const pin = await this.pin(user), local = await this.vault.loadIdentity();
    if (!pin || !local) { local?.seed.fill(0); return undefined; }
    try { return { number: safetyNumber(publicIdentityKey(local.seed), unwrap(unb64u(pin.identity_key))), verified: pin.verified, state: (await this.refresh(user)).state }; }
    finally { local.seed.fill(0); }
  }
  async markVerified(user: string, expectedNumber: string) {
    const state = await this.refresh(user, true), safety = await this.safety(user);
    if (state.state !== 'PINNED' || !state.pin || safety?.number !== expectedNumber) throw new Error('Safety number changed');
    await this.save({ ...state.pin, verified: true }, state.pin); this.peers.delete(user);
  }
  /** Export only pins whose current server view is consistent; retain their full histories. */
  async linkPins() {
    const pins = await this.pins(), accepted: Pin[] = [];
    for (const pin of pins) { const state = await this.refresh(pin.user_id, true); if (state.state === 'PINNED' && state.pin) accepted.push(state.pin); }
    return accepted;
  }
  onKeysChanged(userId: string) { return this.refresh(userId, true); }
  private async own() {
    const state = await this.refresh(this.myId), local = await this.vault.loadIdentity();
    if (!local || !local.confirmed) { local?.seed.fill(0); throw new Error('Set up security key first'); }
    return { state, local, key: b64u(publicIdentityKey(local.seed)) };
  }
  async security(context: DmContext) {
    const peer = await this.refresh(this.peer(context)), local = await this.vault.loadIdentity();
    try {
      const own = local && await this.refresh(this.myId);
      const ready = !!local?.confirmed && own?.state === 'PINNED' && own.pin?.identity_key === b64u(publicIdentityKey(local.seed));
      return { peer, canSend: peer.canSendPlaintext || (peer.canSendEncrypted && ready), label: peer.state === 'KEY_ROLLBACK' ? 'key-problem' : peer.state === 'CHANGED_UNACKNOWLEDGED' ? 'key-changed' : !ready ? 'not-encrypted' : peer.state === 'NONE' ? 'not-encrypted-yet' : this.vault.native ? 'end-to-end-encrypted' : 'encrypted-in-browser' };
    } finally { local?.seed.fill(0); }
  }
  private async seal(context: DmContext, payload: Payload) {
    const peerId = this.peer(context), peer = await this.refresh(peerId), own = await this.own();
    try {
      this.active();
      const currentPeer = await this.pin(peerId), currentOwn = await this.pin(this.myId);
      if (JSON.stringify(currentPeer) !== JSON.stringify(peer.pin) || JSON.stringify(currentOwn) !== JSON.stringify(own.state.pin)) throw new Error('Pinned key changed during send');
      if (peer.state !== 'PINNED' || !peer.pin || own.state.state !== 'PINNED' || own.state.pin?.identity_key !== own.key) throw new Error('Security key not ready');
      const identity = deriveIdentity(own.local.seed); let key: Uint8Array | undefined;
      try {
        key = conversationKey({ channelId: context.id, myId: this.myId, myIdentity: identity, peerId, peerIdentityKey: unwrap(unb64u(peer.pin.identity_key)) });
        return b64u(sealMessage({ key, channelId: context.id, senderId: this.myId, recipientId: peerId, senderKeyRev: own.state.pin.key_rev, recipientKeyRev: peer.pin.key_rev, payload }));
      } finally { key?.fill(0); destroyIdentity(identity); }
    } finally { own.local.seed.fill(0); }
  }
  private async encryptedRequest(context: DmContext, path: string, body: unknown, edit = false) {
    this.active();
    try { const row = edit ? await this.api.patch<SecureMessageRow>(path, body) : await this.api.post<SecureMessageRow>(path, body); this.active(); return row; }
    catch (error) {
      if (error instanceof ApiError && ((error.status === 409 && error.message === 'security key changed; reload keys') || (error.status === 422 && error.message === 'encryption is not available in this conversation'))) {
        await this.refresh(this.peer(context), true); await this.refresh(this.myId, true);
      }
      throw error;
    }
  }
  async send(context: DmContext, text: string, files: FileRef[] = [], reply?: { row: SecureMessageRow; opened: OpenedDmMessage }) {
    const peerId = this.peer(context), state = await this.refresh(peerId);
    if (state.canSendPlaintext) {
      if (files.length || reply) throw new Error('Use legacy attachment/reply transport for plaintext');
      try { this.active(); if (await this.pin(peerId)) throw new Error('Pinned peer cannot receive plaintext'); const row = await this.api.post<SecureMessageRow>(`/api/channels/${encodeURIComponent(context.id)}/messages`, { body: text }); this.active(); return row; }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 422 || !error.message.startsWith('this conversation is end-to-end encrypted')) throw error;
        await this.refresh(peerId, true); // One retry, encrypted only.
      }
    }
    const payload: Payload = { v: 1, text, ...(files.length ? { files } : {}) };
    if (reply) {
      if (reply.row.channel_id !== context.id || reply.opened.status !== 'opened' || reply.row.enc !== 1) throw new Error('Authenticated reply target required');
      payload.re = reply.opened.nonce;
    }
    const envelope = await this.seal(context, payload);
    return this.encryptedRequest(context, `/api/channels/${encodeURIComponent(context.id)}/messages`, { enc: 1, envelope, attachment_ids: files.map(f => f.id), reply_to: reply?.row.id ?? null, mention_ids: [] });
  }
  async edit(context: DmContext, row: SecureMessageRow, payload: Payload, reply?: { row: SecureMessageRow; opened: OpenedDmMessage }) {
    if (row.enc !== 1 || row.channel_id !== context.id || row.author_id !== this.myId) throw new Error('Encrypted own message required');
    const bound: Payload = { v: 1, text: payload.text, ...(payload.files ? { files: payload.files } : {}) };
    if (row.reply_to) {
      if (!reply || reply.row.id !== row.reply_to || reply.row.channel_id !== context.id || reply.row.enc !== 1 || reply.opened.status !== 'opened') throw new Error('Authenticated reply target required');
      bound.re = reply.opened.nonce;
    }
    return this.encryptedRequest(context, `/api/messages/${encodeURIComponent(row.id)}`, { enc: 1, envelope: await this.seal(context, bound), revision: row.revision }, true);
  }
  /** Rebuild from the complete loaded history after fetch/edit/delete; dedupe precedes presentation. */
  async openHistory(context: DmContext, rows: readonly SecureMessageRow[]): Promise<Map<string, OpenedDmMessage>> {
    const peerId = this.peer(context), result = new Map<string, OpenedDmMessage>(), nonces = new Set<string>();
    let peer = await this.refresh(peerId); await this.refresh(this.myId);
    const local = await this.vault.loadIdentity();
    try {
      for (const row of rows) {
        if (row.channel_id !== context.id || !context.memberIds.includes(row.author_id)) { result.set(row.id, { status: 'failed', encrypted: false }); continue; }
        if ((row.enc ?? 0) === 0) { result.set(row.id, plaintextMessage(row.body, peer)); continue; }
        if (row.enc !== 1) { result.set(row.id, { status: 'unsupported', encrypted: false }); continue; }
        if (!local) { result.set(row.id, { status: 'locked', encrypted: false }); continue; }
        const parsed = parseEnvelope(row.envelope); if (!parsed.ok) { result.set(row.id, { status: parsed.error.code === 'UNSUPPORTED_VERSION' ? 'unsupported' : 'failed', encrypted: false }); continue; }
        const ownMessage = row.author_id === this.myId, ownRev = ownMessage ? parsed.value.senderKeyRev : parsed.value.recipientKeyRev, peerRev = ownMessage ? parsed.value.recipientKeyRev : parsed.value.senderKeyRev;
        if (peer.pin && peerRev > peer.pin.key_rev) {
          const fetchId = `${peerId}:${peerRev}`;
          if (!this.envelopeFetches.has(fetchId)) { this.envelopeFetches.add(fetchId); peer = await this.refresh(peerId, true); }
        }
        const pin = peer.pin, peerKey = pin?.history.find(h => h.key_rev === peerRev);
        if (!peerKey) { result.set(row.id, { status: pin && peerRev > pin.key_rev && peer.state === 'CHANGED_UNACKNOWLEDGED' && peer.candidate?.history.some(h => h.key_rev === peerRev) ? 'held' : pin && peerRev <= pin.key_rev ? 'unchecked-peer-key' : 'failed', encrypted: false }); continue; }
        const ownPin = await this.pin(this.myId), ownKey = ownPin?.history.find(h => h.key_rev === ownRev);
        if (ownKey?.identity_key !== b64u(publicIdentityKey(local.seed))) { result.set(row.id, { status: 'old-own-key', encrypted: false }); continue; }
        const identity = deriveIdentity(local.seed); let key: Uint8Array | undefined;
        try {
          key = conversationKey({ channelId: context.id, myId: this.myId, myIdentity: identity, peerId, peerIdentityKey: unwrap(unb64u(peerKey.identity_key)) });
          const opened = openMessage({ key, channelId: context.id, senderId: row.author_id, recipientId: ownMessage ? peerId : this.myId, envelope: row.envelope });
          if (!opened.ok) { result.set(row.id, { status: opened.error.code === 'UNSUPPORTED_VERSION' ? 'unsupported' : 'failed', encrypted: false }); continue; }
          const nonce = b64u(opened.value.nonce);
          if (nonces.has(nonce)) { result.set(row.id, { status: 'duplicate', encrypted: false }); continue; }
          nonces.add(nonce); result.set(row.id, { status: 'opened', payload: opened.value.payload, nonce, encrypted: true, reply: 'none' });
        } catch { result.set(row.id, { status: 'failed', encrypted: false }); }
        finally { key?.fill(0); destroyIdentity(identity); }
      }
      for (const row of rows) {
        const opened = result.get(row.id); if (opened?.status === 'opened') { const target = rows.find(r => r.id === row.reply_to); opened.reply = replyStatus(opened.payload, row, target, target ? result.get(target.id) : undefined); }
      }
      this.active(); return result;
    } finally { local?.seed.fill(0); }
  }
  async uploadAttachment(context: DmContext, plaintext: Uint8Array, name: string, mime: string): Promise<FileRef> {
    const security = await this.security(context); if (!security.canSend || security.peer.state !== 'PINNED') throw new Error('Encrypted conversation required');
    const key = randomBytes(32); let blob: Uint8Array | undefined;
    try {
      // Validate untrusted metadata before uploading anything.
      unwrap(validateFileRef({ id: '00000000-0000-0000-0000-000000000000', key: b64u(key), name, mime, size: plaintext.length }));
      blob = sealFile(key, plaintext);
      this.active(); let upload = await this.api.post<Upload>('/api/uploads', { channel_id: context.id, filename: 'sealed', length: String(blob.length), class: 'sealed' });
      for (let offset = 0; offset < blob.length;) {
        this.active(); const end = Math.min(offset + 4 * 1024 * 1024, blob.length);
        upload = await this.api.request<Upload>(`/api/uploads/${encodeURIComponent(upload.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) }, body: new Blob([blob.slice(offset, end)]) });
        if (upload.offset !== String(end)) throw new Error('Unexpected upload offset'); offset = end;
      }
      this.active(); upload = await this.api.post<Upload>(`/api/uploads/${encodeURIComponent(upload.id)}/complete`, {});
      this.active(); if (upload.status !== 'ready') throw new Error('Sealed upload unavailable');
      return unwrap(validateFileRef({ id: upload.id, key: b64u(key), name, mime, size: plaintext.length }));
    } finally { key.fill(0); blob?.fill(0); }
  }
  async downloadAttachment(row: SecureMessageRow, opened: OpenedDmMessage, id: string) {
    this.active();
    if (opened.status !== 'opened') throw new Error('Authenticated message required');
    const ref = opened.payload.files?.find(f => f.id === id); if (!ref || !row.attachments?.some(a => a.id === id)) throw new Error('Attachment not in message');
    const response = await fetch(this.api.mediaRequest(`/api/media/${encodeURIComponent(id)}`));
    if (!response.ok || !response.body) throw new Error('Attachment unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { this.active(); const r = await reader.read(); if (r.done) break; length += r.value.length; if (length > 104883220) throw new Error('Attachment too large'); chunks.push(r.value); }
      const blob = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { blob.set(chunk, offset); offset += chunk.length; }
      try { this.active(); const bytes = unwrap(openAttachment(ref, row.attachments.map(a => a.id), blob)); return { bytes, name: safeDownloadName(ref.name), mime: inlineMimeAllowed(ref.mime) ? ref.mime : 'application/octet-stream', disposition: inlineMimeAllowed(ref.mime) ? 'inline' as const : 'download' as const, scanned: false as const }; }
      finally { blob.fill(0); }
    } finally { await reader.cancel().catch(() => {}); for (const chunk of chunks) chunk.fill(0); }
  }
  /** Host sign-out: destroy service caches. Install identity remains in the vault. */
  dispose() { this.generation++; this.peers.clear(); this.fetched.clear(); this.envelopeFetches.clear(); }
}
