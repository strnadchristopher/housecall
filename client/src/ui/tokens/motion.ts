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

/** One-column layout. Kept in step with the 47.5em media query in styles/. */
export function usePhone(): boolean {
  return useQuery("(max-width: 47.5em)");
}

/** The right column is a sheet, not a column. Kept in step with the 68.75em media query in styles/. */
export function useSheet(): boolean {
  return useQuery("(max-width: 68.75em)");
}
