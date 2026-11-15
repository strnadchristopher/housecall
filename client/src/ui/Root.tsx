import { useLayoutEffect, useRef } from 'react';
import { useSecurity } from "../core/securityContext";
import { IdentityFlow } from "./security/IdentityFlow";
import { ReceivingFlow, ShowingFlow } from "./security/LinkFlow";
import { Button } from "./kit";
import { copy } from "./copy";
import { useIdentity } from "../core/context";
import { Splash } from "./brand/Splash";
import { Onboarding } from "./onboarding/Onboarding";
import { AppShell } from "./shell/AppShell";
import { UpdateBanner } from "./shell/UpdateBanner";

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
      document.body.style.setProperty('--hc-notices-height', `${element.getBoundingClientRect().height}px`);
      if (element.childElementCount) document.body.style.setProperty('--hc-flow-safe-top', '0px');
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
        {security?.deviceNotice && <div className="hc-security-notice" role="status"><p>{security.deviceNotice}</p><Button kind="text" onClick={security.dismissDeviceNotice}>{copy.common.dismiss}</Button></div>}
      </div>
      {!identity.restoring && (identity.signedIn ? <AppShell /> : <Onboarding />)}
      {security && <IdentityFlow key={identity.me?.id ?? "signed-out"} />}
      {security?.flow === "show" && <ShowingFlow />}
      {security?.flow === "receive" && <ReceivingFlow key={security.receiver ? "receive" : "none"} />}
      <Splash ready={!identity.restoring} server={identity.serverName} />
    </div>
  );
}
