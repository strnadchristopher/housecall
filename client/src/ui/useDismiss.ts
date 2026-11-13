import { useEffect, useRef, type RefObject } from "react";

type Inside = RefObject<Element | null> | ((target: Element) => boolean);

/**
 * Closes something that is open (popover, menu, picker, toolbar) on a press outside it or on Escape.
 * `inside` is the element (or a test for a target) that counts as part of it; presses there are ignored.
 * Capture phase, so a handler that stops propagation cannot keep it open.
 */
export function useDismiss(active: boolean, close: () => void, inside: Inside, options: { escape?: boolean } = {}) {
  const closeRef = useRef(close);
  const insideRef = useRef(inside);
  closeRef.current = close;
  insideRef.current = inside;
  const escape = options.escape ?? true;
  useEffect(() => {
    if (!active) return;
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      const test = insideRef.current;
      const hit = typeof test === "function" ? !!target && test(target) : !!target && !!test.current?.contains(target);
      if (!hit) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => { if (escape && event.key === "Escape") closeRef.current(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey); };
  }, [active, escape]);
}
