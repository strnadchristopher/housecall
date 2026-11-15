import type { DmContext } from './dm';
import type { SecurityVault } from './security';

/** Native bindings share the secure vault and lifetime of pins. Web bindings stay in page memory. */
export class ConversationBindings {
  private peers = new Map<string, string | undefined>();
  private current = new Map<string, { kind: string; peer_id?: string | null }>();
  private messages = new Map<string, string>();
  private uploads = new Map<string, string>();
  private loaded: boolean;
  private pending = 0;
  private failed = false;
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private account: string, private vault?: SecurityVault, private origin = '') {
    this.loaded = !vault;
    this.ready = vault ? vault.loadBindings(origin, account).then(rows => {
      for (const row of rows) this.peers.set(row.id, row.peer ?? undefined);
      this.loaded = true;
    }).catch(() => { this.failed = true; }) : Promise.resolve();
  }
  private checkReady() {
    if (!this.loaded || this.pending || this.failed) throw new Error('Conversation security storage is not ready. Sending is paused.');
  }
  /** Load before trusting fresh metadata; persist new bindings before outgoing operations. */
  observe(rows: readonly { id: string; kind: string; peer_id?: string | null }[]): Promise<void> {
    if (!this.vault) { this.apply(rows); return Promise.resolve(); }
    this.pending++;
    const work = this.writes.then(async () => {
      await this.ready;
      if (this.failed) throw new Error('Conversation security storage unavailable');
      const before = JSON.stringify([...this.peers]);
      this.apply(rows);
      if (before !== JSON.stringify([...this.peers])) await this.vault!.saveBindings(this.origin, this.account, [...this.peers].map(([id, peer]) => ({ id, peer: peer ?? null })));
    }).catch(error => { this.failed = true; throw error; }).finally(() => { this.pending--; });
    this.writes = work.catch(() => {});
    return work;
  }
  /** Standalone services also establish membership before crypto/plaintext/upload entry points. */
  async establish(context: DmContext) {
    await this.ready; await this.writes; this.checkReady();
    const peer = context.memberIds.find(id => id !== this.account);
    if (!this.current.has(context.id)) await this.observe([{ id: context.id, kind: context.kind, peer_id: peer }]);
    this.assert(context.id);
    if (this.peers.get(context.id) !== peer) throw new Error('Conversation security details changed. Sending is paused until the original details return.');
  }
  private apply(rows: readonly { id: string; kind: string; peer_id?: string | null }[]) {
    this.current = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) if (row.kind === 'dm') {
      const peer = row.peer_id && row.peer_id !== this.account ? row.peer_id : undefined;
      // Incomplete first metadata stays a DM, but may acquire its first valid peer later.
      if (!this.peers.get(row.id)) this.peers.set(row.id, peer);
    }
  }
  observeMessages(rows: readonly { id: string; channel_id: string }[]) {
    for (const row of rows) if (!this.messages.has(row.id)) this.messages.set(row.id, row.channel_id);
  }
  observeResponse(path: string, value: unknown, options: RequestInit = {}) {
    if (!/^\/api\/uploads(?:\/|$)/.test(path) || !value || typeof value !== 'object') return;
    const row = value as { id?: unknown; channel_id?: unknown };
    const requestedChannel = path === '/api/uploads' && options.method === 'POST' && typeof options.body === 'string' ? JSON.parse(options.body).channel_id : undefined;
    const channel = requestedChannel ?? row.channel_id;
    if (typeof row.id === 'string' && typeof channel === 'string' && !this.uploads.has(row.id)) this.uploads.set(row.id, channel);
  }
  isDm(id: string) { return this.peers.has(id); }
  valid(id: string) {
    const row = this.current.get(id), peer = this.peers.get(id);
    return !!peer && row?.kind === 'dm' && row.peer_id === peer;
  }
  context(id: string): DmContext | undefined {
    const peer = this.peers.get(id);
    return peer ? { id, kind: 'dm', memberIds: [this.account, peer] } : undefined;
  }
  assert(id: string) {
    this.checkReady();
    if (this.isDm(id) && !this.valid(id)) throw new Error('Conversation security details changed. Sending is paused until the original details return.');
  }
  /** Runs synchronously at the transport boundary, including uploads resumed by old callbacks. */
  guard(path: string, options: RequestInit, selected: string) {
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) this.checkReady();
    const channel = /^\/api\/channels\/([^/?]+)/.exec(path)?.[1];
    if (channel) this.assert(decodeURIComponent(channel));
    const message = /^\/api\/messages\/([^/?]+)/.exec(path)?.[1];
    if (message) this.assert(this.messages.get(decodeURIComponent(message)) ?? selected);
    const upload = /^\/api\/uploads\/([^/?]+)/.exec(path)?.[1];
    if (upload) this.assert(this.uploads.get(decodeURIComponent(upload)) ?? selected);
    if (/^\/api\/(uploads|giphy|embeds|link-preview|previews|snaps)(\/|\?|$)/.test(path)) this.assert(selected);
    if (path === '/api/uploads' && typeof options.body === 'string') {
      const body = JSON.parse(options.body); if (typeof body.channel_id === 'string') this.assert(body.channel_id);
    }
  }
}
