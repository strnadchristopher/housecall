import type { Preflight } from "../../core/identity";
import { copy } from "../copy";

const C = copy.onboarding.preflight;
export type PreflightRow = { id: "https" | "call_port" | "storage"; label: string; ok: boolean; help?: string; href?: string };

const DOC = "docs/SELF-HOSTING.md";
const ANCHOR = { https: "https", call_port: "call-port", storage: "storage" } as const;

/** Turns the server's booleans and reason codes into rows. Copy and doc links live here, not on the server. */
export function preflightRows(result: Preflight): PreflightRow[] {
  return (["https", "call_port", "storage"] as const).map(id => {
    const check = result[id];
    if (check.ok) return { id, label: C.labels[id], ok: true };
    const help = (check.reason && C.help[id][check.reason]) || C.help[id].default;
    return { id, label: C.labels[id], ok: false, help, href: `${DOC}#${ANCHOR[id]}` };
  });
}
