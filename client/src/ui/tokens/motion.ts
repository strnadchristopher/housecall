import { useEffect, useState } from "react";

function useQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setMatches(list.matches);
    list.addEventListener("change", on);
    on();
    return () => list.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** True when the person asked for no motion. Read when an exit starts, so a change applies to the next one. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs `done` once an exit animation of `ms` has played, or straight away when motion is reduced.
 * Returns a canceller for when the thing comes back before the exit finished.
 */
export function afterExit(ms: number, reduced: boolean, done: () => void): () => void {
  if (reduced) { done(); return () => {}; }
  const timer = setTimeout(done, ms);
  return () => clearTimeout(timer);
}

/** One-column layout. Kept in step with the 47.5em media query in styles/. */
export function usePhone(): boolean {
  return useQuery("(max-width: 47.5em)");
}

/** A touch screen is the main pointer, whatever the width (tablets). */
export function useCoarsePointer(): boolean {
  return useQuery("(pointer: coarse)");
}

/** The right column is a sheet, not a column. Kept in step with the 68.75em media query in styles/. */
export function useSheet(): boolean {
  return useQuery("(max-width: 68.75em)");
}
