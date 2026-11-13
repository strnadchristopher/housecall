import { useEffect, useId, useRef, type ReactNode } from "react";
import { copy } from "./copy";
import { IconButton, Presence } from "./kit";

/**
 * HC-040 section 1.2 sheet: a bottom sheet on phones, a centred dialog on wide screens. Escape and a tap on
 * the scrim close it; focus moves in and returns to what opened it.
 */
export function Sheet({ open, onClose, title, children, actions, testId }: {
  open: boolean; onClose: () => void; title: ReactNode; children?: ReactNode; actions?: ReactNode; testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heading = useId();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = ref.current?.querySelector<HTMLElement>("input, button, [href]");
    first?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); (opener.current as HTMLElement | null)?.focus?.({ preventScroll: true }); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Presence show={open} ms={110}>
      <div className="hc-sheet-scrim hc-anim-fade" onClick={onClose} />
      <div ref={ref} className="hc-sheet hc-anim-rise" role="dialog" aria-modal="true" aria-labelledby={heading} data-testid={testId}>
        <span className="hc-sheet__grip" aria-hidden="true" />
        <div className="hc-sheet__head"><h2 id={heading}>{title}</h2><IconButton icon="close" label={copy.common.close} onClick={onClose} /></div>
        {children}
        {actions && <div className="hc-sheet__actions">{actions}</div>}
      </div>
    </Presence>
  );
}
