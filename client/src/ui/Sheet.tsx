import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copy } from "./copy";
import { IconButton, Presence } from "./kit";

/**
 * HC-040 section 1.2 sheet: a bottom sheet on phones, a centred dialog on wide screens. Escape and a tap on
 * the scrim close it; focus moves in and returns to what opened it.
 */
export function Sheet({ open, onClose, title, children, actions, testId, fullScreen = false, dismissible = true, sensitive = false }: {
  open: boolean; onClose: () => void; title: ReactNode; children?: ReactNode; actions?: ReactNode; testId?: string; fullScreen?: boolean; dismissible?: boolean; sensitive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heading = useId();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = ref.current?.querySelector<HTMLElement>("input, button, [href]");
    first?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (dismissible) onClose(); }
      if (event.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(item => !item.hidden);
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (!ref.current.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); (opener.current as HTMLElement | null)?.focus?.({ preventScroll: true }); };
  }, [open, dismissible]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open && (sensitive || fullScreen)) return null;
  const content = <>
    {!fullScreen && <span className="hc-sheet__grip" aria-hidden="true" />}
    <div className={fullScreen ? "hc-onb__title" : "hc-sheet__head"}>
      {fullScreen ? <h1 id={heading}>{title}</h1> : <h2 id={heading}>{title}</h2>}
      {dismissible && <IconButton icon={fullScreen ? "back" : "close"} label={fullScreen ? copy.common.back : copy.common.close} onClick={onClose} />}
    </div>
    {children}
    {actions && <div className={fullScreen ? "hc-onb__actions" : "hc-sheet__actions"}>{actions}</div>}
  </>;
  return createPortal(<Presence show={open} ms={110}>
    {!fullScreen && <div className="hc-sheet-scrim hc-anim-fade" onClick={dismissible ? onClose : undefined} />}
    <div ref={ref} className={fullScreen ? "hc-onb hc-security-onb" : "hc-sheet hc-anim-rise"} role="dialog" aria-modal="true" aria-labelledby={heading} data-testid={testId}>
      {fullScreen ? <div className="hc-onb__screen is-wide">{content}</div> : content}
    </div>
  </Presence>, document.body);
}
