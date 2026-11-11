import { useEffect, useState } from "react";

/** Motion values are CSS tokens; scripts read them here instead of repeating numbers. */
export function reducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function duration(token: "fast" | "base" | "slow"): number {
  if (reducedMotion()) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--hc-dur-${token}`).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** One-column layout. Kept in step with the 47.5em media queries in styles/. */
const PHONE = "(max-width: 47.5em)";
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia !== "undefined" && matchMedia(PHONE).matches);
  useEffect(() => {
    const query = matchMedia(PHONE);
    const on = () => setPhone(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return phone;
}
