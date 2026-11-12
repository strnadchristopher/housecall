import "./tokens.css";
import "./directions/b.css";
import "./directions/c.css";
// After the directions, so the chosen accent wins over a direction's own.
import "./accents.css";

/**
 * Review aid, not a product setting: ?direction=b or ?direction=c selects an
 * alternate token set and is remembered; ?direction=a returns to the default.
 */
export type Direction = "a" | "b" | "c";
const KEY = "hc-direction";

function read(): Direction {
  let chosen: string | null = null;
  try {
    chosen = new URLSearchParams(location.search).get("direction");
    if (chosen === "a" || chosen === "b" || chosen === "c") localStorage.setItem(KEY, chosen);
    else chosen = localStorage.getItem(KEY);
  } catch {
    /* storage can be unavailable; the default direction still applies */
  }
  return chosen === "b" || chosen === "c" ? chosen : "a";
}

let active: Direction = "a";

export function applyDirection(): Direction {
  active = read();
  if (active === "a") delete document.documentElement.dataset.direction;
  else document.documentElement.dataset.direction = active;
  return active;
}

export function direction(): Direction {
  return active;
}
