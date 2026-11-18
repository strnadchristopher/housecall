import { afterEach, expect, it, vi } from 'vitest';
import { verifyLinkApproval } from '../src/transport/linkVerification';
import { Api } from '../src/transport/api';
import { SecurityApi } from '../src/adapters/legacy/security';
import { memoryOnlyNativeStorage } from '../src/transport/identityStorage';
import { parseSchemeInvite, stripBrowserLinkFragment } from '../src/transport/deepLinks';
import { parseDeepLink } from '../src/crypto/link';
afterEach(() => { vi.unstubAllGlobals(); });
it('cancelled OS verification cannot fall through to password; desktop fallback checks real password route with session headers', async () => {
  const invoke = vi.fn(async () => ({ supported: true, verified: false })); vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => { expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session'); expect(JSON.parse(String(init?.body))).toEqual({ password: 'typed password' }); return new Response(JSON.stringify({ ok: true })); }); vi.stubGlobal('fetch', fetch);
  const api = new Api('https://chat.example.test'); api.authenticate({ token: 'session', device_key: 'device' }); const remote = new SecurityApi(api);
  expect(await verifyLinkApproval(remote, 'Pixel 9', 'typed password')).toBe(false); expect(fetch).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('plugin:secure-session|verify_owner', { reason: 'Approve logging in on Pixel 9' });
  invoke.mockResolvedValue({ supported: false, verified: false }); await expect(verifyLinkApproval(remote, 'Pixel 9')).rejects.toThrow('Password'); expect(await verifyLinkApproval(remote, 'Pixel 9', 'typed password')).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  invoke.mockRejectedValue(new Error('native failure')); await expect(verifyLinkApproval(remote, 'Pixel 9', 'typed password')).rejects.toThrow('native failure'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('web has no native approval or native memory fallback; code-carrying schemes are refused', async () => {
  vi.stubGlobal('window', {}); await expect(verifyLinkApproval(new SecurityApi(new Api()), 'Device', 'password')).rejects.toThrow('Native'); expect(() => memoryOnlyNativeStorage()).toThrow('Native');
  expect(parseDeepLink('housecall://link-scan')).toEqual({ ok: true, value: { action: 'scan' } });
  for (const text of ['housecall://link?c=hcl1.secret', 'housecall://link-scan?c=secret', 'housecall://link-scan#secret']) { expect(parseDeepLink(text).ok).toBe(false); expect(parseSchemeInvite(text)).toBeUndefined(); }
});
it('legacy browser link fragments are stripped synchronously and discarded', () => {
  vi.stubGlobal('window', {}); vi.stubGlobal('location', { origin: 'https://chat.example.test', hash: '#link=hcl1.id.secret.A', pathname: '/', search: '' });
  const replaceState = vi.fn(); vi.stubGlobal('history', { state: null, replaceState });
  expect(stripBrowserLinkFragment()).toBeUndefined(); expect(replaceState).toHaveBeenCalledWith(null, '', '/');
});
