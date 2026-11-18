import { afterEach, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BackendProvider } from '../src/core/context';
import { SecurityContext, type SecurityUI } from '../src/core/securityContext';
import { canScanLoginQr } from '../src/transport/loginQr';
import { subscribeInviteLinks } from '../src/transport/deepLinks';
import { ReceivingFlow } from '../src/ui/security/LinkFlow';
import { IdentityFlow } from '../src/ui/security/IdentityFlow';
import { DmSecurityBanner } from '../src/ui/security/DmSecurity';
import { Onboarding } from '../src/ui/onboarding/Onboarding';
import { useSecurityUI } from '../src/adapters/legacy/useSecurityUI';
import { copy } from '../src/ui/copy';
const vault = vi.hoisted(() => ({ native: false }));
vi.mock('../src/adapters/legacy/securityRuntime', () => ({ installVault: () => vault, securitySession: () => ({}), pendingLink: () => undefined }));
// Render sheet contents without a DOM/portal; camera is a tripwire for direct entry.
vi.mock('../src/ui/Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null }));
vi.mock('../src/ui/snap/SnapCamera', () => ({ SnapCamera: () => { throw new Error('login camera mounted'); } }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', desktop = 'Mozilla/5.0 (X11; Linux x86_64)';
function platform(native: boolean, userAgent: string) { vault.native = native; vi.stubGlobal('navigator', { userAgent }); vi.stubGlobal('location', { origin: 'https://chat.example.test' }); }
function render(component: ReactNode, native: boolean, security: Partial<SecurityUI> = {}) {
  const backend = { identity: { native, remembered: [], pendingRequests: [], adding: true, error: '', me: { id: 'me' } }, chat: { current: { kind: 'dm', name: 'Peer' }, dmSecurity: { canSend: false, peer: {} }, error: '' }, call: {}, chords: {} };
  return renderToStaticMarkup(createElement(BackendProvider, { value: backend as any, children: createElement(SecurityContext.Provider, { value: { flow: 'identity', origin: 'https://chat.example.test', status: { phase: 'needs-import', keyRev: 1 }, ...security } as SecurityUI, children: component }) }));
}
it.each([[false, desktop], [false, phone], [true, desktop]])('blocks scanner rendering and hides invalid login/unlock actions: native=%s UA=%s', (native, ua) => {
  platform(native, ua); expect(canScanLoginQr(native)).toBe(false);
  expect(render(createElement(ReceivingFlow), native, { flow: 'receive', scanImmediately: true })).toBe('');
  const identity = render(createElement(IdentityFlow), native);
  expect(identity).toContain(copy.keys.getWords); expect(identity).not.toContain('Scan a QR code from a device');
  const banner = render(createElement(DmSecurityBanner), native);
  expect(banner).toContain(copy.e2e.enterKey); expect(banner).not.toContain(copy.e2e.useDevice);
  const login = render(createElement(Onboarding), native);
  expect(login).toContain('type="password"'); expect(login).not.toContain(copy.link.title);
});
it('native phones retain scanner and recovery actions', () => {
  for (const ua of [phone, 'Android', 'iPad']) {
    platform(true, ua); expect(canScanLoginQr(true)).toBe(true);
    const identity = render(createElement(IdentityFlow), true);
    expect(identity).toContain('Scan a QR code from a device'); expect(identity).toContain(copy.keys.getWords);
    expect(() => render(createElement(ReceivingFlow), true, { flow: 'receive', scanImmediately: true })).toThrow('login camera mounted');
  }
});
it.each([[false, desktop], [false, phone], [true, desktop], [true, phone]])('controller gates receive before API access: native=%s UA=%s', async (native, ua) => {
  platform(native, ua); const get = vi.fn().mockRejectedValue(new Error('phone reached session lookup')); let security!: SecurityUI;
  function Probe() { security = useSecurityUI({ api: { serverOrigin: () => 'https://chat.example.test', get }, auth: { user: { id: 'me' } } } as any, { id: 'host' } as any, {} as any); return null; }
  renderToStaticMarkup(createElement(Probe));
  for (const immediate of [false, true]) {
    if (canScanLoginQr(native)) await expect(security.openReceive(immediate)).rejects.toThrow('phone reached session lookup');
    else await security.openReceive(immediate);
  }
  expect(get).toHaveBeenCalledTimes(canScanLoginQr(native) ? 2 : 0);
});
it.each([desktop, phone])('native deep links dispatch scanner only on phones: %s', async ua => {
  platform(true, ua); vi.useFakeTimers(); const scan = vi.fn(), invite = vi.fn();
  const invoke = vi.fn(async (command: string) => command === 'scheme_invite_take' ? { url: 'housecall://link-scan' } : { url: 'housecall://link-scan', id: 'fixture' });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke }, addEventListener() {}, removeEventListener() {} });
  const stop = subscribeInviteLinks(invite, undefined, scan); await vi.advanceTimersByTimeAsync(1); stop();
  expect(scan).toHaveBeenCalledTimes(ua === phone ? 2 : 0); expect(invite).not.toHaveBeenCalled();
});
