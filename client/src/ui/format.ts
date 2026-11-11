/** Display formatting only. Byte sizes arrive as decimal strings (never lossy numbers). */

export { nameOf } from "../data/people";

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(dec: string | number | bigint): string {
  let n: bigint;
  try { n = BigInt(typeof dec === 'number' ? Math.round(dec) : dec); } catch { return String(dec); }
  if (n < 1000n) return `${n} B`;
  let unit = 0;
  let whole = n;
  let scaled = n * 10n;
  while (whole >= 1000n && unit < UNITS.length - 1) { whole /= 1000n; scaled /= 1000n; unit++; }
  const tenths = Number(scaled % 10n);
  const value = Number(scaled / 10n);
  return value >= 100 || tenths === 0 ? `${value} ${UNITS[unit]}` : `${value}.${tenths} ${UNITS[unit]}`;
}

/** Fraction sent/total from decimal strings, clamped 0..1. */
export function fraction(sent: string, total: string): number {
  try {
    const t = BigInt(total);
    if (t === 0n) return 0;
    return Math.min(1, Math.max(0, Number((BigInt(sent) * 10000n) / t) / 10000));
  } catch { return 0; }
}

export function rate(bps?: number): string {
  if (!bps) return '';
  return `${bytes(Math.round(bps))}/s`;
}

export function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function day(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yest = new Date(now - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function relative(ms: number, now = Date.now()): string {
  const diff = Math.round((now - ms) / 1000);
  const future = diff < 0;
  const a = Math.abs(diff);
  const v = a < 45 ? 'just now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  if (v === 'just now') return v;
  return future ? `in ${v}` : `${v} ago`;
}

export function kbps(bps?: number): string {
  return bps ? `${Math.round(bps / 1000)} kbps` : 'not measured';
}
