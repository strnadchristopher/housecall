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
  const identity = useIdentity();
  const security = useSecurity();
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
      {!identity.restoring && (identity.signedIn ? <AppShell /> : <Onboarding />)}
      {security && <IdentityFlow key={identity.me?.id ?? "signed-out"} />}
      {security?.flow === "show" && <ShowingFlow />}
      {security?.flow === "receive" && <ReceivingFlow key={security.receiver ? "receive" : "none"} />}
      <Splash ready={!identity.restoring} server={identity.serverName} />
    </div>
  );
}
