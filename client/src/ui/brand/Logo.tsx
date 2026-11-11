import { direction } from "../tokens/direction";
import { copy } from "../copy";

/**
 * The mark for the active direction, drawn on a 32 unit grid and sized by the
 * font size of its container (1.5em). Colours come from tokens.
 *  a: a lowercase h whose counter is a lit doorway with the door ajar
 *  b: the double l of the wordmark as two parallel strokes
 *  c: a roofline over a single dot
 */
export function Logo({ open, label = copy.app.name }: { open?: boolean; label?: string }) {
  const which = direction();
  return (
    <svg className="hc-logo" data-open={open ? "" : undefined} viewBox="0 0 32 32" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {which === "a" && (
        <>
          <path className="hc-logo__ink" d="M6 3H12V10.83A10 10 0 0 1 26 20V29H20V20A4 4 0 0 0 12 20V29H6Z" />
          <path className="hc-logo__lit" d="M12 29V20A4 4 0 0 1 20 20V29Z" />
          <path className="hc-logo__leaf" d="M12 29V20A4 4 0 0 1 12.6 17.9L15.4 19.6V29Z" />
        </>
      )}
      {which === "b" && (
        <>
          <path className="hc-logo__ink" d="M8 6.2L14 3V29H8Z" />
          <path className="hc-logo__ink" d="M18 6.2L24 3V29H18Z" />
        </>
      )}
      {which === "c" && (
        <>
          <path className="hc-logo__stroke" d="M5 17.5L16 7L27 17.5" />
          <circle className="hc-logo__lit" cx="16" cy="24" r="3.4" />
        </>
      )}
    </svg>
  );
}
