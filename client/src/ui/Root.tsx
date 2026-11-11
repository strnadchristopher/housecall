import { useIdentity } from "../core/context";
import { Onboarding } from "./onboarding/Onboarding";
import { AppShell } from "./shell/AppShell";
import { UpdateBanner } from "./shell/UpdateBanner";

/** Signed out: onboarding. Signed in: the shell. */
export function Root() {
  const identity = useIdentity();
  return (
    <div className="hc-root">
      <UpdateBanner />
      {identity.signedIn ? <AppShell /> : <Onboarding />}
    </div>
  );
}
