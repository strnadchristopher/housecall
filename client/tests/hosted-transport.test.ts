import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedTarget } from '../src/hosted/target';
import { Api } from '../src/transport/api';
describe('host-bound browser transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends community credentials only to its selected origin, omits cookies and refuses redirects', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const api = new Api('https://alpha.fixture.org');
    api.authenticate({ token: 'synthetic-session', device_key: 'synthetic-device' });
    await api.post('/api/login', { username: 'fixture', password: 'synthetic password' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://alpha.fixture.org/api/login');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-session');
    expect(new Headers(init.headers).get('X-Device-Key')).toBe('synthetic-device');
    const media = api.mediaRequest('/api/media/synthetic');
    expect(new URL(media.url).origin).toBe('https://alpha.fixture.org'); expect(media.credentials).toBe('omit'); expect(media.redirect).toBe('error');
    expect(() => api.mediaRequest('https://beta.fixture.org/api/media/synthetic')).toThrow();
    expect(() => api.mediaRequest('https://user:password@alpha.fixture.org/api/media/synthetic')).toThrow();
    await expect(api.post('https://beta.fixture.org/api/login', {})).rejects.toThrow('API path required');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects credential URLs, insecure origins and central-origin targets', () => {
    vi.stubGlobal('location', { origin: 'https://hosted.fixture.org' });
    for (const input of ['https://user:secret@alpha.fixture.org', 'https://alpha.fixture.org?token=secret', 'http://alpha.fixture.org', 'https://hosted.fixture.org']) expect(() => hostedTarget(input)).toThrow();
    expect(hostedTarget('alpha.fixture.org')).toEqual({ origin: 'https://alpha.fixture.org', token: '' });
  });
  it('keeps independent sessions for two mounted hosts and clears authentication', async () => {
    const alpha = new Api('https://alpha.fixture.org'), beta = new Api('https://beta.fixture.org');
    alpha.authenticate({ token: 'alpha-fixture', device_key: 'alpha-device' }); beta.authenticate({ token: 'beta-fixture', device_key: 'beta-device' });
    expect(alpha.mediaRequest('/api/media/test').headers.get('Authorization')).toBe('Bearer alpha-fixture');
    expect(beta.mediaRequest('/api/media/test').headers.get('Authorization')).toBe('Bearer beta-fixture');
    alpha.authenticate(); expect(alpha.mediaRequest('/api/media/test').headers.has('Authorization')).toBe(false);
    expect(beta.mediaRequest('/api/media/test').headers.get('Authorization')).toBe('Bearer beta-fixture');
  });
});
