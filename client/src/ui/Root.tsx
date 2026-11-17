import { useHosted } from "../hosted/HostedAccount";
import { AccountLogin, DirectLogin, HostedHome } from "../hosted/HostedViews";
import { useLayoutEffect, useRef } from 'react';
import { useSecurity } from "../core/securityContext";
import { IdentityFlow } from "./security/IdentityFlow";
import { ReceivingFlow, ShowingFlow } from "./security/LinkFlow";
import { useIdentity } from "../core/context";
import { Splash } from "./brand/Splash";
import { Onboarding } from "./onboarding/Onboarding";
import { AppShell } from "./shell/AppShell";
import { UpdateBanner } from "./shell/UpdateBanner";
import { DeviceNotice } from "./shell/DeviceNotice";

/** Signed out: onboarding. Signed in: the shell. */
export function Root() {
  const hosted = useHosted();
  const identity = useIdentity();
  const security = useSecurity();
  const ready = !identity.restoring && (!hosted?.restoring || identity.signedIn || hosted.view === 'direct');
  const notices = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = notices.current;
    if (!element) return;
    // Portalled full-screen flows share the same measured space as the flex shell.
    // This also tracks wrapping, safe insets, viewport changes and update-banner changes.
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      document.body.style.setProperty('--hc-notices-height', `${height}px`);
      const safeTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hc-safe-top')) || 0;
      if (height > 0) document.body.style.setProperty('--hc-flow-safe-top', `${Math.max(0, safeTop - height)}px`);
      else document.body.style.removeProperty('--hc-flow-safe-top');
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => { observer.disconnect(); document.body.style.removeProperty('--hc-notices-height'); document.body.style.removeProperty('--hc-flow-safe-top'); };
  }, []);
  return (
    <div className="hc-root">
      <div className="hc-notices" ref={notices}>
        <UpdateBanner />
        {security && <DeviceNotice text={security.deviceNotice} onDone={security.dismissDeviceNotice} />}
      </div>
      {ready && <div hidden={!!hosted?.overlay} style={{ display: hosted?.overlay ? "none" : "contents" }}>{identity.signedIn ? <AppShell /> : identity.adding ? <Onboarding /> : hosted ? hosted.view === 'direct' ? <DirectLogin /> : hosted.account.list ? <HostedHome /> : <AccountLogin /> : <Onboarding />}</div>}
      {ready && hosted?.overlay && <AccountLogin onBack={() => hosted.setOverlay(false)} />}
      {security && <IdentityFlow key={identity.me?.id ?? "signed-out"} />}
      {security?.flow === "show" && <ShowingFlow />}
      {security?.flow === "receive" && <ReceivingFlow key={security.receiver ? "receive" : "none"} />}
      <Splash ready={ready} server={identity.serverName} />
    </div>
  );
}
