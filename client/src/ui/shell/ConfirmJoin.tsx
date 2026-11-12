import { useEffect, useRef } from "react";
import { useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Button, Presence } from "../kit";
import { Logo } from "../brand/Logo";

/**
 * An invite link that arrived from outside while you are signed in asks once before joining (a pasted code
 * joins straight away). A sheet from the bottom on a phone, a small panel on wide screens. Escape is Not now.
 */
export function ConfirmJoin() {
  const identity = useIdentity();
  const offer = identity.pendingJoin;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offer) return;
    panel.current?.querySelector<HTMLButtonElement>(".hc-btn--primary")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      identity.dismissJoin();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [offer?.host]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Presence show={!!offer}>
      <div className="hc-confirm-join">
        {/* Tapping outside is Not now; the real Not now button carries the name, so the scrim stays out of the tree. */}
        <div className="hc-confirm-join__scrim hc-anim-fade" aria-hidden="true" onClick={identity.dismissJoin} />
        <div ref={panel} className="hc-confirm-join__panel hc-anim-rise" role="alertdialog" aria-modal="true" aria-labelledby="hc-confirm-join-title"
          aria-describedby="hc-confirm-join-body" data-testid="confirm-join">
          <Logo open label="" />
          <h2 id="hc-confirm-join-title">{copy.join.confirm(offer?.host ?? "")}</h2>
          <p id="hc-confirm-join-body">{copy.join.body}</p>
          <div className="hc-confirm-join__actions">
            <Button kind="primary" onClick={identity.confirmJoin}>{copy.join.join}</Button>
            <Button kind="text" onClick={identity.dismissJoin}>{copy.join.notNow}</Button>
          </div>
        </div>
      </div>
    </Presence>
  );
}
