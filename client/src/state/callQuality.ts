import { copy } from "../ui/copy";

/** HC-040 section 6.2: the measured connection, as bars. `rttMs` and `loss` come from getStats(); absent means not measured. */
export interface Quality {
  phase: "idle" | "connecting" | "live" | "failed";
  rttMs?: number;
  loss?: number;
}

export function lossFraction(lost: number, received: number): number {
  const total = lost + received;
  return total > 0 && lost > 0 ? lost / total : 0;
}

export function signalBars(q: Quality): 0 | 1 | 2 | 3 {
  if (q.phase !== "live" || q.rttMs === undefined) return 0;
  const loss = q.loss ?? 0;
  if (q.rttMs < 80 && loss < 0.02) return 3;
  if (q.rttMs < 200 && loss < 0.06) return 2;
  return 1;
}

export function signalTip(q: Quality): string {
  if (q.phase === "failed") return copy.call.noConnection;
  if (q.phase !== "live" || q.rttMs === undefined) return copy.call.measuring;
  return copy.call.latency(Math.round(q.rttMs));
}

export type CardState = "connecting" | "connected" | "weak" | "failed";
export function cardState(q: Quality): CardState {
  if (q.phase === "failed") return "failed";
  if (q.phase !== "live") return "connecting";
  return signalBars(q) === 1 ? "weak" : "connected";
}
