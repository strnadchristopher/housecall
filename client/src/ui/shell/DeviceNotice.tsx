import { useEffect, useState } from "react";
import { Button } from "../kit";
import { copy } from "../copy";

const SHOW_MS = 6000, LEAVE_MS = 260;

/** "New device logged in" slides down, waits, then slides away on its own (Dismiss also slides). */
export function DeviceNotice({ text, onDone }: { text?: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    setLeaving(false);
    if (!text) return;
    const timer = setTimeout(() => setLeaving(true), SHOW_MS);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!leaving) return;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(onDone, reduce ? 0 : LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!text) return null;
  return (
    <div className={leaving ? 'hc-device-notice is-leaving' : 'hc-device-notice'}>
      <div className="hc-device-notice__clip">
        <div className={leaving ? "hc-security-notice is-leaving" : "hc-security-notice"} role="status" data-testid="device-notice">
          <p>{text}</p>
          <Button kind="text" onClick={() => setLeaving(true)}>{copy.common.dismiss}</Button>
        </div>
      </div>
    </div>
  );
}
