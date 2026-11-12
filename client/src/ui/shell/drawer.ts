import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag the phone drawer toward its edge to close it. The drawer follows the finger (through --hc-drag on the
 * shell, with transitions off while dragging); letting go past a third of its width, or with a quick flick,
 * closes it, otherwise it settles back open. Vertical moves are left to the list's own scrolling.
 */
export function useDrawerDrag(shell: React.RefObject<HTMLElement | null>, enabled: boolean, close: () => void) {
  const start = useRef<{ x: number; y: number; t: number; id: number; width: number; dragging: boolean } | undefined>(undefined);
  const reset = () => {
    const element = shell.current;
    start.current = undefined;
    if (!element) return;
    delete element.dataset.dragging;
    element.style.removeProperty("--hc-drag");
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button > 0) return;
    start.current = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId, width: event.currentTarget.getBoundingClientRect().width, dragging: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const from = start.current;
    const element = shell.current;
    if (!from || from.id !== event.pointerId || !element) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (!from.dragging) {
      // Decide once: a mostly horizontal move toward the edge is a drag; anything else is a scroll or a tap.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dx >= 0 || Math.abs(dy) > Math.abs(dx)) { start.current = undefined; return; }
      from.dragging = true;
      element.dataset.dragging = "";
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    element.style.setProperty("--hc-drag", `${Math.min(0, dx)}px`);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const from = start.current;
    if (!from || from.id !== event.pointerId) return;
    const dx = Math.min(0, event.clientX - from.x);
    const speed = dx / Math.max(1, event.timeStamp - from.t); // px per ms, negative toward the edge
    const dragged = from.dragging;
    reset();
    if (dragged && (dx < -from.width / 3 || speed < -0.5)) close();
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset };
}
