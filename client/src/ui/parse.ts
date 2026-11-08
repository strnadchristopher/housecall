/**
 * The v1 contract hands presentation one `text` string per item. These
 * parsers recover structure from the exact strings App.tsx builds so the UI
 * can design them, and always fall back to the raw text when a string does not
 * match. Nothing here invents data. See docs/UI-REQUESTS.md for the structured
 * fields that would make parsing unnecessary.
 */

const PICTO = /\p{Extended_Pictographic}/u;
function isEmojiToken(t: string) { return PICTO.test(t) && !/[\p{L}\p{N}]/u.test(t.replace(/[⃣️]/g, '')); }
function trailingEmoji(s: string) {
  let n = 0;
  let probe = ' ' + s.trimEnd();
  for (;;) {
    const m = /\s(\S+)$/u.exec(probe);
    if (!m || !isEmojiToken(m[1])) return n;
    n++;
    probe = probe.slice(0, m.index);
  }
}

export interface ParsedMessage {
  author: string;
  /** Body exactly as sent (no flags). */
  body: string;
  reply: boolean;
  pinned: boolean;
  reactions: { emoji: string; count: number }[];
  /** Everything after the body, verbatim, for the text-equivalence invariant. */
  suffix: string;
}

/** `${username}: ${body}${reply?" (reply)":""}${pinned?" (pinned)":""}${reactions.map(r=>" "+r)}` */
export function parseMessage(text: string, plainBody?: string): ParsedMessage {
  const sep = text.indexOf(': ');
  const author = sep > 0 ? text.slice(0, sep) : '';
  let rest = sep > 0 ? text.slice(sep + 2) : text;
  // Reactions: trailing " <emoji>" tokens. A body can also end in emoji, so
  // when no flag sits between body and reactions, the body's own trailing
  // emoji (known from its plain text) are handed back to the body.
  const cuts: { at: number; emoji: string }[] = [];
  let probe = rest;
  for (;;) {
    const m = /\s(\S+)$/u.exec(probe);
    if (!m || !isEmojiToken(m[1])) break;
    cuts.unshift({ at: m.index, emoji: m[1] });
    probe = probe.slice(0, m.index);
  }
  let keep = 0;
  if (cuts.length && plainBody !== undefined && !/ \((pinned|reply)\)$/.test(probe)) {
    keep = Math.min(cuts.length, trailingEmoji(plainBody));
  }
  const emojis = cuts.slice(keep).map(c => c.emoji);
  if (cuts.length > keep) rest = rest.slice(0, cuts[keep].at);
  let pinned = false;
  let reply = false;
  if (rest.endsWith(' (pinned)')) { pinned = true; rest = rest.slice(0, -' (pinned)'.length); }
  if (rest.endsWith(' (reply)')) { reply = true; rest = rest.slice(0, -' (reply)'.length); }
  const counts = new Map<string, number>();
  for (const e of emojis) counts.set(e, (counts.get(e) ?? 0) + 1);
  const suffix = text.slice((sep > 0 ? sep + 2 : 0) + rest.length);
  return { author, body: rest, reply, pinned, reactions: [...counts].map(([emoji, count]) => ({ emoji, count })), suffix };
}

/** `${name}: ${id}` used by member pickers. */
export function parseNameId(text: string): { name: string; id: string } | null {
  const i = text.lastIndexOf(': ');
  if (i <= 0) return null;
  return { name: text.slice(0, i), id: text.slice(i + 2) };
}

export interface ParsedUpload { name: string; sent: string; total: string; status: string; video?: string; videoError?: string }
/** `${filename}: ${offset}/${length} bytes (${status})[ — Video: ${status}[ (${error})]]` */
export function parseUpload(text: string): ParsedUpload | null {
  const m = /^(.*): (\d+)\/(\d+) bytes \(([a-z_]+)\)(?: — Video: ([a-z_]+)(?: \((.*)\))?)?$/s.exec(text);
  if (!m) return null;
  return { name: m[1], sent: m[2], total: m[3], status: m[4], video: m[5], videoError: m[6] };
}

export interface ParsedVoice { phase: string; bytes?: string; frames?: string; error?: string }
/** `${phase}; received ${n} bytes; decoded ${n} frames[; ${error}]` */
export function parseVoice(text: string): ParsedVoice {
  const m = /^([a-z]+); received (\d+) bytes; decoded (\d+) frames(?:; (.*))?$/s.exec(text);
  if (!m) return { phase: text.split(';')[0] ?? text };
  return { phase: m[1], bytes: m[2], frames: m[3], error: m[4] };
}

export interface ParsedSnapshot { kind: string; revision: number; playing: boolean; positionMs: number; controller: string | null }
/** `${kind} revision ${n}; playing|paused; position ${ms}; controller ${name|none}` */
export function parseSnapshot(text: string): ParsedSnapshot | null {
  const m = /^(\w+) revision (\d+); (playing|paused); position (\d+); controller (.+)$/.exec(text);
  if (!m) return null;
  return { kind: m[1], revision: Number(m[2]), playing: m[3] === 'playing', positionMs: Number(m[4]), controller: m[5] === 'none' ? null : m[5] };
}

/** `${title} (${N} seconds)` for DJ search results. */
export function parseDuration(text: string): { title: string; seconds?: number } {
  const m = /^(.*) \((\d+) seconds\)$/s.exec(text);
  return m ? { title: m[1], seconds: Number(m[2]) } : { title: text };
}

/** `${title} (${kind})` for Plex items. */
export function parseKind(text: string): { title: string; kind?: string } {
  const m = /^(.*) \(([a-z]+)\)$/s.exec(text);
  return m ? { title: m[1], kind: m[2] } : { title: text };
}

export interface ParsedReport { kind: string; body: string; status: string; logs?: string }
/** `${kind}: ${body} (${status})[ — Consented logs: ${logs}]` */
export function parseReport(text: string): ParsedReport | null {
  const logsAt = text.indexOf(' — Consented logs: ');
  const head = logsAt >= 0 ? text.slice(0, logsAt) : text;
  const logs = logsAt >= 0 ? text.slice(logsAt + ' — Consented logs: '.length) : undefined;
  const m = /^(\w+): (.*) \((\w+)\)$/s.exec(head);
  if (!m) return null;
  return { kind: m[1], body: m[2], status: m[3], logs };
}

/** `${query}: ${status}` for Gimme request items. */
export function parseGimme(text: string): { title: string; status: string } {
  const i = text.indexOf(': ');
  return i > 0 ? { title: text.slice(0, i), status: text.slice(i + 2) } : { title: text, status: '' };
}

export type GimmeTone = 'preview' | 'ok' | 'wait' | 'warn' | 'fail';
export function gimmeTone(status: string): GimmeTone {
  if (/^Preview saved/.test(status)) return 'preview';
  if (/failed|unavailable|without a usable/i.test(status)) return 'fail';
  if (/Confirmation required|unknown|uncertain|paused/i.test(status)) return 'warn';
  if (/queued|processing|Subscribed/i.test(status)) return 'wait';
  return 'ok';
}

/** Stable small hash for picking a tint from a name. */
export function hashOf(s: string) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

export function clockMs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
