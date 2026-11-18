import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IdentityStorage } from '../src/transport/identityStorage';
import { copy } from '../src/ui/copy';

const script = readFileSync('public/link/link.js', 'utf8');
function page(fragment: string, origin = 'https://chat.example.test') {
  const operations: string[] = [], nodes = new Map<string, { hidden: boolean; textContent: string; href: string; remove(): void }>();
  for (const name of ['ok', 'missing', 'host', 'web']) nodes.set(name, { hidden: name === 'ok', textContent: '', href: '/', remove() { operations.push(`remove:${name}`); nodes.delete(name); } });
  let ready: () => void = () => {};
  const history = { replaceState(_: unknown, __: string, path: string) { operations.push('strip'); expect(path).toBe('/link'); } };
  runInNewContext(script, {
    location: { hash: fragment, origin, host: new URL(origin).host }, history, URL,
    document: { addEventListener(event: string, cb: () => void) { expect(event).toBe('DOMContentLoaded'); ready = cb; }, getElementById(id: string) { operations.push(`read:${id}`); return nodes.get(id); } },
    fetch() { throw new Error('Static handoff attempted network'); },
  });
  expect(operations).toEqual(['strip']); ready();
  return { nodes, operations };
}
describe('actual static handoff executable, without a browser or network', () => {
  const code = `#hcl1.${'ab'.repeat(16)}.${'A'.repeat(43)}.${'E'.repeat(42)}A`;
  it('hides/removes every action for missing, malformed, noncanonical, excessive and non-TLS remote codes', () => {
    for (const fragment of ['', '#bad', code + '=', code.replace(/A$/, 'B'), '#' + 'x'.repeat(513)]) {
      const { nodes } = page(fragment); expect(nodes.has('ok')).toBe(false); expect(nodes.get('missing')?.hidden).toBe(false);
    }
    expect(page(code, 'http://remote.example.test').nodes.has('ok')).toBe(false);
  });
  it('strips before DOM access and offers only a payload-free native handoff', () => {
    const { nodes } = page(code); expect(nodes.get('ok')?.hidden).toBe(false);
    expect(nodes.get('web')?.href).toBe('/');
    expect(script).not.toContain('#link=');
    const html = readFileSync('public/link/index.html', 'utf8');
    expect(html).toContain('href="housecall://link-scan"'); expect(html).not.toContain('link?c='); expect(html).not.toContain('id="web"'); expect(html).not.toContain('Continue in browser');
    expect(html.indexOf('<script src=')).toBeLessThan(html.indexOf('<body>'));
    expect(html).not.toContain('<style>'); expect(html).not.toContain('hc-hash');
    for (const name of ['index.html', 'link.js', 'link.css']) expect(readFileSync('public/link/' + name, 'utf8')).toBe(readFileSync('../server/src/link_page/' + name, 'utf8'));
  });
});
it('native corrupt identity is a visible store failure, never an empty identity or an overwrite', async () => {
  const storage = new IdentityStorage(async <T,>() => ({ identity: { seed: 'bad', recovery_rev: 1 } }) as T);
  await expect(storage.loadIdentity()).rejects.toThrow('Secure storage unavailable'); expect(storage.availability).toBe('memory-unavailable');
});
it('browser signout erases identity and pin partitions without touching native session commands', async () => {
  const storage = new IdentityStorage(); await storage.saveIdentity({ seed: new Uint8Array(32).fill(9), recoveryRev: 1, confirmed: true });
  await storage.clearBrowserSession(); expect(await storage.loadIdentity()).toBeNull(); expect(await storage.loadPins('https://chat.example.test', 'me')).toEqual([]);
});
it('protected warning strings state irreversible browser exposure, replacement and relay limits', () => {
  expect(copy.keys.browserWords('host')).toContain('on every device');
  expect(copy.security.replaceBody).toContain('Replacing does not stop old words that have already leaked.');
  expect(copy.e2e.relayedTip).toContain('could listen');
});

it('renders every plaintext marker in grouped and ungrouped rows with the protected explanation', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BackendProvider } = await import('../src/core/context');
  const { Message } = await import('../src/ui/chat/Message');
  const message = {
    id: 'fixture', authorId: 'peer', authorName: 'Fixture peer', body: 'plaintext fixture', nodes: [{ kind: 'text', text: 'plaintext fixture' }],
    createdAt: 1, pinned: false, replyTo: null, reactions: [], mentionsMe: false, attachments: [], mine: false, canEdit: false, canUnsend: false, gifs: [],
    plaintextMarker: true, security: { status: 'plaintext', body: 'plaintext fixture', marker: 'not-encrypted', encrypted: false },
  };
  for (const grouped of [false, true]) {
    const html = renderToStaticMarkup(createElement(BackendProvider, { value: { chat: { me: { id: "me" } }, identity: {}, call: {}, chords: {} } as any, children: createElement(Message, { message: message as any, grouped, me: 'me', stop: false, open: false, onToggle() {} }) }));
    expect(html).toContain('hc-msg__plain'); expect(html).toContain('Not encrypted'); expect(html).toContain('The host could have written or changed it.');
    expect(html).not.toContain('End-to-end encrypted');
  }
});

it('binds DM membership through missing/self/different peer and kind changes without affecting channels/groups', async () => {
  const { ConversationBindings } = await import('../src/core/conversationBinding');
  const { Api } = await import('../src/transport/api');
  const bindings = new ConversationBindings('me');
  const good = { id: 'dm', kind: 'dm', peer_id: 'peer' };
  bindings.observe([good, { id: 'group', kind: 'group_dm' }, { id: 'channel', kind: 'channel' }]);
  bindings.observeMessages([{ id: 'original', channel_id: 'dm' }]);
  bindings.observeResponse('/api/uploads', { id: 'upload', channel_id: 'host-substituted-channel' }, { method: 'POST', body: JSON.stringify({ channel_id: 'dm' }) });
  const context = bindings.context('dm');
  const api = new Api('https://chat.example.test');
  api.requestGuard = (path, options) => bindings.guard(path, options, 'dm');
  const { vi } = await import('vitest');
  const network = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', network);
  try {
    for (const change of [{ peer_id: null }, { peer_id: 'me' }, { peer_id: 'other' }, { kind: 'group_dm' }, { kind: 'channel' }]) {
      bindings.observe([{ ...good, ...change }]);
      expect(bindings.context('dm')).toEqual(context);
      expect(bindings.valid('dm')).toBe(false);
      await expect(api.post('/api/channels/dm/messages', { body: 'must never leave' })).rejects.toThrow('security details changed');
      await expect(api.patch('/api/messages/original', { body: 'edit secret' })).rejects.toThrow('security details changed');
      await expect(api.post('/api/uploads', { channel_id: 'dm', filename: 'private.txt' })).rejects.toThrow('security details changed');
      expect(() => api.mediaRequest('/api/snaps/private/open', { method: 'POST' })).toThrow('security details changed');
      expect(() => bindings.guard('/api/uploads/upload', { method: 'PATCH', body: 'raw bytes' }, 'group')).toThrow('security details changed');
      expect(network).not.toHaveBeenCalled();
      expect(() => bindings.assert('group')).not.toThrow(); expect(() => bindings.assert('channel')).not.toThrow();
    }
    bindings.observe([good]); expect(bindings.valid('dm')).toBe(true);
    bindings.observe([{ id: 'incomplete', kind: 'dm', peer_id: null }]);
    expect(() => bindings.assert('incomplete')).toThrow();
  } finally { vi.unstubAllGlobals(); }
});

it('Android registers both invite and exact payload-free scan hosts; Kotlin still validates exact scan URI', () => {
  const manifest = readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8');
  for (const host of ['invite', 'link-scan']) expect(manifest).toContain(`android:scheme="housecall" android:host="${host}"`);
  const policy = readFileSync('src-tauri/gen/android/app/src/main/java/com/mapleavenuelabs/housecall/NativeAuthPolicy.kt', 'utf8');
  expect(policy).toContain('it == "housecall://link-scan"');
  expect(copy.e2e.changedBody.startsWith('`')).toBe(false); expect(copy.e2e.changedBody.endsWith('`')).toBe(false);
});

it('distinguishes late old-credential 401 responses from genuine current-session 401 responses', async () => {
  const { Api, ApiError } = await import('../src/transport/api');
  const { vi } = await import('vitest');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', async () => { await held; return new Response(JSON.stringify({ error: 'revoked' }), { status: 401 }); });
  try {
    const api = new Api('https://chat.example.test'); api.authenticate({ token: 'old', device_key: 'old-device' });
    const old = api.get('/api/events').catch(error => error);
    api.authenticate({ token: 'replacement', device_key: 'replacement-device' }); release();
    const oldError = await old; if (!(oldError instanceof ApiError)) throw new Error('Expected old 401'); expect(api.isCurrentSessionError(oldError)).toBe(false);
    const currentError = await api.get('/api/events').catch(error => error);
    if (!(currentError instanceof ApiError)) throw new Error('Expected current 401');
    expect(api.isCurrentSessionError(currentError)).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it.each(['paused-resume', 'between-chunks'])('stops an existing plaintext attachment after peer publication: %s', async transition => {
  const { vi } = await import('vitest');
  const { Api } = await import('../src/transport/api');
  const { DmService } = await import('../src/adapters/legacy/dm');
  const { ResumableUpload } = await import('../src/transport/uploads');
  const { b64u, publicIdentityKey } = await import('../src/crypto/identity');
  const origin = 'https://chat.example.test', vault = new IdentityStorage();
  const api = new Api(origin), dm = new DmService(api, vault, origin, 'me');
  const context = { id: 'dm', kind: 'dm' as const, memberIds: ['me', 'peer'] };
  const file = new File([new Uint8Array(8 * 1024 * 1024 + 3).fill(65)], 'private.txt');
  let published = false, offset = 0, paused = false;
  const outbound: { method: string; bytes: number; sealed: boolean }[] = [];
  const row = () => ({ id: 'legacy', channel_id: 'dm', filename: file.name, length: String(file.size), offset: String(offset), status: offset === file.size ? 'ready' : 'uploading' });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const key = b64u(publicIdentityKey(new Uint8Array(32).fill(42)));
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? 'GET';
    if (path.startsWith('/api/users/')) {
      const user = path.split('/')[3];
      return json({ user_id: user, identity_key: published && user === 'peer' ? key : null, key_rev: published && user === 'peer' ? 1 : 0, history: published && user === 'peer' ? [{ key_rev: 1, identity_key: key }] : [] });
    }
    if (method === 'PATCH') {
      const bytes = (init!.body as Blob).size; outbound.push({ method, bytes, sealed: false }); offset += bytes;
      if (transition === 'between-chunks') published = true;
    }
    if (method === 'POST') outbound.push({ method, bytes: 0, sealed: false });
    return json(row());
  });
  try {
    const uploader = new ResumableUpload(api, upload => {
      if (transition === 'paused-resume' && upload.offset !== '0' && !paused) { paused = true; uploader.pause(); }
    });
    // Same DmService gate and resumable transport used by the composer, with real fetch bodies.
    const permit = <T,>(send: () => Promise<T>) => dm.withLegacyPlaintext(context, send);
    const target = await uploader.create(context.id, file, permit);
    const started = uploader.resume(target.id, file, permit);
    await expect(started).rejects.toThrow();
    expect(outbound.filter(r => r.method === 'PATCH').map(r => r.bytes)).toEqual([4 * 1024 * 1024]);
    const before = structuredClone(outbound);
    published = true; await dm.onKeysChanged('peer');
    await expect(uploader.resume(target.id, file, permit)).rejects.toThrow('Pinned peer');
    expect(outbound).toEqual(before); // Cumulative: Resume sends zero more plaintext bytes or completion writes.
    expect((await vault.loadPins(origin, 'me')).find(p => p.user_id === 'peer')?.identity_key).toBe(key);
    // Even a host key removal cannot reopen the old transfer.
    published = false; await dm.onKeysChanged('peer');
    await expect(uploader.resume(target.id, file, permit)).rejects.toThrow('Pinned peer');
    expect(outbound).toEqual(before);
  } finally { vi.unstubAllGlobals(); }
});

it.each(['channel', 'keyless-dm'])('keeps ordinary resumable attachment uploads functional: %s', async kind => {
  const { vi } = await import('vitest');
  const { Api } = await import('../src/transport/api');
  const { DmService } = await import('../src/adapters/legacy/dm');
  const { ResumableUpload } = await import('../src/transport/uploads');
  const origin = 'https://chat.example.test', api = new Api(origin);
  const dm = new DmService(api, new IdentityStorage(), origin, 'me');
  const context = { id: 'room', kind: 'dm' as const, memberIds: ['me', 'peer'] };
  const file = new File(['permitted original bytes'], 'ordinary.txt');
  let offset = 0, complete = false;
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith('/api/users/')) return new Response(JSON.stringify({ user_id: path.split('/')[3], identity_key: null, key_rev: 0, history: [] }));
    if (init?.method === 'PATCH') { bodies.push(await (init.body as Blob).text()); offset += (init.body as Blob).size; }
    if (path.endsWith('/complete')) complete = true;
    return new Response(JSON.stringify({ id: 'ordinary', channel_id: 'room', filename: file.name, length: String(file.size), offset: String(offset), status: complete ? 'ready' : 'uploading' }));
  });
  try {
    const uploader = new ResumableUpload(api, () => {});
    const permit = kind === 'channel' ? undefined : <T,>(send: () => Promise<T>) => dm.withLegacyPlaintext(context, send);
    const target = await uploader.create('room', file, permit);
    expect(await uploader.resume(target.id, file, permit)).toMatchObject({ status: 'ready' });
    expect(bodies).toEqual(['permitted original bytes']);
  } finally { vi.unstubAllGlobals(); }
});
