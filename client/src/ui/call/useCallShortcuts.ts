import { useEffect, useRef } from "react";
import { useCall } from "../../core/context";

/** Shortcuts shown in Settings. `mod` is Ctrl, or Cmd on a Mac. */
export const SHORTCUTS = [
  { id: "mute", keys: ["mod", "Shift", "M"] },
  { id: "deafen", keys: ["mod", "Shift", "D"] },
] as const;

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
export function keyLabel(key: string): string {
  return key === "mod" ? (isMac() ? "Cmd" : "Ctrl") : key;
}

/** Mute and deafen from the keyboard while you are in a call and Housecall is in front. */
export function useCallShortcuts() {
  const call = useCall();
  const latest = useRef(call);
  latest.current = call;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || !(isMac() ? event.metaKey : event.ctrlKey) || event.altKey) return;
      const current = latest.current;
      if (current.phase !== "live") return;
      const key = event.key.toLowerCase();
      if (key === "m") { event.preventDefault(); current.setMuted(!current.muted); }
      else if (key === "d") { event.preventDefault(); current.setDeafened(!current.deafened); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
